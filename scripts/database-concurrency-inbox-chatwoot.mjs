import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * MSG-005. Prova contra Postgres real, como `service_role`, o aceite da entrega
 * na inbox do Chatwoot (`aceitar_entrega_inbox_chatwoot`):
 *
 * 1. rajadas de 100 chamadas em 30 conexões: mesmo delivery id; mesmo evento em
 *    delivery ids diferentes; sem delivery id. Sempre um evento, um único "novo"
 *    e nenhum erro (a função legada estourava 23505 nessa corrida);
 * 2. 40 revisões distintas da mesma mensagem, em paralelo: 40 eventos;
 * 3. mesmo delivery id e mesma chave em A1, A2 e B1 com transações abertas ao
 *    mesmo tempo: nenhuma espera a outra, três eventos;
 * 4. antes do commit: outra sessão não enxerga a entrega; a sessão que cai antes
 *    do commit não deixa evento nem entrega, e a reentrega grava como nova. Uma
 *    entrega em paralelo espera a primeira e, se ela abortar, grava;
 * 5. ACK só depois do commit: quando a chamada em autocommit retorna (o ponto em
 *    que o webhook pode responder 2xx), a linha já é visível em outra sessão;
 * 6. delivery id reutilizado com outro evento: 23505 e nada gravado;
 * 7. desligar a conexão espera a entrega em curso; a seguinte é recusada (55000).
 */

const ORG_A = 'e5500000-0000-4000-8000-00000000000a';
const ORG_B = 'e5500000-0000-4000-8000-00000000000b';
const A1 = 'e5500000-0000-4000-8000-0000000000c1';
const A2 = 'e5500000-0000-4000-8000-0000000000c2';
const B1 = 'e5500000-0000-4000-8000-0000000000c3';
const CONEXOES = 30;

const ACEITAR = `select * from public.aceitar_entrega_inbox_chatwoot($1, $2, null, 1, $3, $4, 'message_created', '{"event":"x"}'::jsonb)`;

async function aceitar(client, org, conexao, delivery, chave) {
  try {
    return { ok: true, linha: (await client.query(ACEITAR, [org, conexao, delivery, chave])).rows[0] };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined };
  }
}

async function semear(client) {
  await client.query(
    `insert into public.organizacoes (id, nome, slug, status) values
       ($1, 'Org A Inbox', 'org-a-inbox-m5', 'active'), ($2, 'Org B Inbox', 'org-b-inbox-m5', 'active')`,
    [ORG_A, ORG_B],
  );
  await client.query(
    `insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
       ($1, $4, 'chatwoot', 'A1', 'conectado'), ($2, $4, 'chatwoot', 'A2', 'conectado'), ($3, $5, 'chatwoot', 'B1', 'conectado')`,
    [A1, A2, B1, ORG_A, ORG_B],
  );
}

async function contar(admin, chave, delivery) {
  const { rows: [{ eventos }] } = await admin.query(
    'select count(*)::int as eventos from public.inbox_eventos_chatwoot where idempotency_key = $1', [chave]);
  const { rows: [{ entregas }] } = await admin.query(
    'select count(*)::int as entregas from public.inbox_entregas_chatwoot where delivery_id = $1 or chave_evento = $2', [delivery ?? '', chave]);
  return { eventos, entregas };
}

/** Dispara `total` chamadas distribuídas nas conexões, todas ao mesmo tempo. */
async function rajada(pool, total, chamada) {
  let proxima = 0;
  const resultados = [];
  await Promise.all(pool.map(async (client) => {
    while (proxima < total) {
      const i = proxima;
      proxima += 1;
      resultados.push(await chamada(client, i));
    }
  }));
  return resultados;
}

async function rajadas({ admin, pool }) {
  const casos = [
    { nome: 'MesmaEntrega', chave: 'v2:message_created:msg:1', delivery: () => 'rajada-1', eventos: 1, entregas: 1 },
    { nome: 'MesmoEvento', chave: 'v2:message_created:msg:2', delivery: (i) => `rajada-2-${i}`, eventos: 1, entregas: 100 },
    { nome: 'SemDelivery', chave: 'v2:message_created:msg:3', delivery: () => null, eventos: 1, entregas: 0 },
  ];
  for (const caso of casos) {
    const resultados = await rajada(pool, 100, (client, i) => aceitar(client, ORG_A, A1, caso.delivery(i), caso.chave));
    const falhas = resultados.filter((r) => !r.ok);
    const novos = resultados.filter((r) => r.ok && !r.linha.is_duplicate);
    const contagem = await contar(admin, caso.chave, caso.delivery(0));
    if (falhas.length > 0 || novos.length !== 1 || contagem.eventos !== caso.eventos || contagem.entregas !== caso.entregas) {
      return err(`InboxRajada${caso.nome}Incorreta`, `Rajada ${caso.nome} fora do esperado`, {
        falhas: falhas.length, codigos: [...new Set(falhas.map((f) => f.code))], novos: novos.length, ...contagem,
      });
    }
  }
  return ok({ resumo: '100 chamadas por caso (mesma entrega, mesmo evento, sem id): 1 evento, 1 novo, 0 erros' });
}

async function revisoes({ admin, pool }) {
  const resultados = await rajada(pool, 40, (client, i) =>
    aceitar(client, ORG_A, A1, `rev-${i}`, `v2:message_updated:msg:10:drev-${i}:digest`));
  const { rows: [{ eventos }] } = await admin.query(
    "select count(*)::int as eventos from public.inbox_eventos_chatwoot where idempotency_key like 'v2:message_updated:msg:10:%'");
  if (resultados.some((r) => !r.ok || r.linha.is_duplicate) || eventos !== 40) {
    return err('InboxRevisaoEngolida', 'Revisão legítima tratada como duplicata', { eventos });
  }
  return ok({ resumo: '40 revisões paralelas: 40 eventos' });
}

async function instalacoes({ admin, clientA, clientB, terceiro }) {
  const chave = 'v2:message_created:msg:500';
  await clientA.query('BEGIN');
  await clientB.query('BEGIN');
  await terceiro.query('BEGIN');
  try {
    const resultados = [
      await aceitar(clientA, ORG_A, A1, 'mesmo-id', chave),
      await aceitar(clientB, ORG_A, A2, 'mesmo-id', chave),
      await aceitar(terceiro, ORG_B, B1, 'mesmo-id', chave),
    ];
    if (resultados.some((r) => !r.ok || r.linha.is_duplicate)) {
      return err('InboxInstalacoesColidiram', 'Instalações com os mesmos ids colidiram', { resultados });
    }
  } finally {
    for (const client of [clientA, clientB, terceiro]) await client.query('COMMIT').catch(() => {});
  }
  const { eventos, entregas } = await contar(admin, chave, 'mesmo-id');
  if (eventos !== 3 || entregas !== 3) return err('InboxInstalacoesMisturadas', 'Esperava uma linha por instalação', { eventos, entregas });
  return ok({ resumo: 'A1, A2 e B1 com ids iguais e transações abertas: sem espera, 3 eventos' });
}

async function antesDoCommit({ admin, clientB, novoCliente, timeoutDeObservacaoMs }) {
  const chave = 'v2:message_created:msg:600';

  // Sessão cai antes do commit: nada fica, e a reentrega é nova.
  const caindo = await novoCliente();
  await caindo.query('BEGIN');
  const primeira = await aceitar(caindo, ORG_A, A1, 'queda-1', chave);
  if (!primeira.ok) return err('InboxInicioFalhou', 'Primeira entrega falhou', { primeira });
  const visivel = await contar(admin, chave, 'queda-1');
  if (visivel.eventos !== 0 || visivel.entregas !== 0) return err('InboxVisivelAntesDoCommit', 'Entrega visível antes do commit', visivel);
  const { rows: [{ pid }] } = await caindo.query('select pg_backend_pid() as pid');

  // Reentrega em paralelo espera a primeira; com a queda, grava como nova.
  const pidB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const paralela = aceitar(clientB, ORG_A, A1, 'queda-1', chave);
  const observacao = await observarBloqueioNoPostgres(admin, pidB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) return err('InboxNaoEsperou', 'A entrega paralela não esperou a primeira', {});
  caindo.on('error', () => {});
  await admin.query('select pg_terminate_backend($1)', [pid]);
  const reentrega = await paralela;
  await caindo.end().catch(() => {});
  if (!reentrega.ok || reentrega.linha.is_duplicate) {
    return err('InboxReentregaPerdida', 'Reentrega depois da queda não gravou como nova', { reentrega });
  }
  const depois = await contar(admin, chave, 'queda-1');
  if (depois.eventos !== 1 || depois.entregas !== 1) return err('InboxResiduoDaQueda', 'Queda deixou resíduo', depois);
  return ok({ resumo: 'queda antes do commit: invisível, sem resíduo; reentrega paralela esperou e gravou' });
}

async function ackDepoisDoCommit({ admin, clientA }) {
  const chave = 'v2:message_created:msg:700';
  const r = await aceitar(clientA, ORG_A, A1, 'ack-1', chave);
  // Sem nenhuma espera: é o instante em que o webhook responderia 2xx.
  const { rows } = await admin.query(
    `select e.status, d.delivery_id from public.inbox_eventos_chatwoot e
       join public.inbox_entregas_chatwoot d on d.evento_id = e.id where e.idempotency_key = $1`, [chave]);
  if (!r.ok || rows.length !== 1 || rows[0].status !== 'received' || rows[0].delivery_id !== 'ack-1') {
    return err('InboxAckAntesDoCommit', 'A chamada retornou sem a entrega durável', { rows });
  }
  const redelivery = await aceitar(clientA, ORG_A, A1, 'ack-1', chave);
  if (!redelivery.ok || redelivery.linha.duplicata !== 'entrega') {
    return err('InboxRedeliveryNaoReconhecido', 'ACK perdido: redelivery não reconhecido', { redelivery });
  }
  return ok({ resumo: 'no retorno da chamada a entrega já é visível em outra sessão; o redelivery é duplicata de entrega' });
}

async function entregaReutilizada({ admin, clientA }) {
  const r = await aceitar(clientA, ORG_A, A1, 'ack-1', 'v2:message_created:msg:701');
  const { eventos } = await contar(admin, 'v2:message_created:msg:701', null);
  if (r.ok || r.code !== '23505' || eventos !== 0) {
    return err('InboxEntregaReutilizadaAceita', 'Delivery id reutilizado não foi recusado por inteiro', { r, eventos });
  }
  return ok({ resumo: 'delivery id reutilizado: 23505, sem evento parcial' });
}

async function desligarEspera({ admin, clientA, clientB, timeoutDeObservacaoMs }) {
  await clientA.query('BEGIN');
  const emCurso = await aceitar(clientA, ORG_A, A2, 'em-curso', 'v2:message_created:msg:800');
  if (!emCurso.ok) {
    await clientA.query('ROLLBACK');
    return err('InboxInicioFalhou', 'Entrega em curso falhou', { emCurso });
  }
  const pidB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const desligar = clientB.query("update public.conexoes_integracao set status = 'desconectado' where id = $1", [A2]);
  const observacao = await observarBloqueioNoPostgres(admin, pidB, { timeoutMs: timeoutDeObservacaoMs });
  await clientA.query('COMMIT');
  await desligar;
  if (!observacao.observado) return err('InboxDesligarNaoEsperou', 'O desligamento não esperou a entrega em curso', {});
  const depois = await aceitar(clientA, ORG_A, A2, 'depois', 'v2:message_created:msg:801');
  if (depois.ok || depois.code !== '55000') return err('InboxDesligadaAceitou', 'Conexão desligada aceitou entrega', { depois });
  return ok({ resumo: 'desligar esperou a entrega em curso; a seguinte foi recusada (55000)' });
}

/**
 * @param {{ readonly timeoutDeObservacaoMs?: number }} [options] - Espera máxima pela observação do bloqueio.
 * @returns {Promise<object>} Resultado tagueado do rehearsal.
 */
export async function runInboxChatwootRaceRehearsal({ timeoutDeObservacaoMs = 5_000 } = {}) {
  const abertos = [];
  const novoCliente = async () => {
    const client = createLocalDatabaseClient('orbita-inbox-chatwoot');
    await client.connect();
    await client.query('set role service_role');
    abertos.push(client);
    return client;
  };
  const admin = createLocalDatabaseClient('orbita-inbox-chatwoot-admin');
  try {
    await admin.connect();
    await semear(admin);
    const [clientA, clientB, terceiro] = await Promise.all([novoCliente(), novoCliente(), novoCliente()]);
    const pool = await Promise.all(Array.from({ length: CONEXOES }, novoCliente));
    const ctx = { admin, clientA, clientB, terceiro, pool, novoCliente, timeoutDeObservacaoMs };

    const resumos = [];
    for (const etapa of [rajadas, revisoes, instalacoes, antesDoCommit, ackDepoisDoCommit, entregaReutilizada, desligarEspera]) {
      const resultado = await etapa(ctx);
      if (resultado._tag === 'err') return resultado;
      resumos.push(resultado.value.resumo);
    }
    return ok(Object.freeze({ relato: `inbox do Chatwoot (MSG-005) provada no Postgres: ${resumos.join('; ')}` }));
  } catch (cause) {
    return err('InboxChatwootRehearsalFailed', 'Falha inesperada no rehearsal da inbox Chatwoot', {}, cause);
  } finally {
    for (const client of [admin, ...abertos]) {
      try {
        await client.end();
      } catch {
        // Encerramento de conexão de teste; nada a fazer se já caiu.
      }
    }
  }
}
