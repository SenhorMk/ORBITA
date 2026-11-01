import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * MSG-006. Prova contra Postgres real, como `service_role`, o consumo da inbox do
 * Chatwoot (`reivindicar_eventos_inbox_chatwoot`, `aplicar_evento_inbox_chatwoot`):
 *
 * 1. oito workers em 120 eventos de 12 conversas: cada evento reivindicado uma vez,
 *    token 1, 12 casos, 12 auditorias, nenhum erro;
 * 2. 40 mensagens da mesma conversa em oito workers: um caso, 39 somadas;
 * 3. queda antes do commit (conexão morta com a transação aberta): nada fica; depois
 *    da lease, outro worker conclui uma vez;
 * 4. queda depois do commit (ACK da RPC perdido): nada se repete;
 * 5. worker pausado com lease vencida: cercado, e o novo dono conclui;
 * 6. lease vence com a transação aberta: a linha travada impede o takeover;
 * 7. redelivery durante o consumo e depois dele: sem evento novo, sem caso novo;
 * 8. desligar a conexão espera o consumo; o seguinte não é reivindicado;
 * 9. A e B com os mesmos ids remotos, em paralelo: não se misturam.
 *
 * Contraprovas, por sabotagem medida e revertida: sem lease, sem fencing, sem a
 * transação única, sem a guarda de idempotência. Cada uma tem de produzir o defeito.
 */

const ORG_A = 'e6100000-0000-4000-8000-00000000000a';
const ORG_B = 'e6100000-0000-4000-8000-00000000000b';
const A1 = 'e6100000-0000-4000-8000-0000000000c1';
const B1 = 'e6100000-0000-4000-8000-0000000000c2';
const WORKERS = 8;

const ACEITAR = `select * from public.aceitar_entrega_inbox_chatwoot($1, $2, null, 1, null, $3, $4, '{"event":"x"}'::jsonb)`;
const REIVINDICAR = 'select * from public.reivindicar_eventos_inbox_chatwoot($1, $2, $3)';
const APLICAR = 'select * from public.aplicar_evento_inbox_chatwoot($1, $2, $3, $4::jsonb)';

function comandoDaMensagem(mensagem, conversa, contato, extra = {}) {
  return {
    evento: 'message_created',
    acao: 'espelhar',
    account_id: '1',
    abre_caso: true,
    contato: { id: contato, nome: `Sintetico ${contato}` },
    conversa: { id: conversa, contato_id: contato, status: 'open', inbox_id: 1, canal: 'Channel::Api' },
    mensagem: { id: mensagem, conversa_id: conversa, conteudo: 'sintetico', tipo: 'incoming', modo: 'preservar' },
    ...extra,
  };
}

async function aceitar(client, org, conexao, chave, tipo = 'message_created') {
  return (await client.query(ACEITAR, [org, conexao, chave, tipo])).rows[0];
}

async function reivindicar(client, worker, limite = 50, lease = 60) {
  return (await client.query(REIVINDICAR, [worker, limite, lease])).rows;
}

async function aplicar(client, eventoId, worker, token, comando) {
  return (await client.query(APLICAR, [eventoId, worker, token, JSON.stringify(comando)])).rows[0];
}

async function casosDe(admin, org) {
  return (await admin.query('select count(*)::int as n from public.sac_cases where organizacao_id = $1', [org])).rows[0].n;
}

async function linhaDo(admin, eventoId) {
  return (await admin.query(
    'select status, disposicao, attempts, fencing_token::int as token, lease_owner, caso_id from public.inbox_eventos_chatwoot where id = $1',
    [eventoId])).rows[0];
}

async function vencerLease(admin, eventoId) {
  await admin.query("update public.inbox_eventos_chatwoot set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [eventoId]);
}

/** Cada etapa usa uma organização própria: conta só o que ela mesma fez. */
async function novaOrganizacao(admin, sufixo) {
  const { rows: [{ org, conexao }] } = await admin.query('select gen_random_uuid() as org, gen_random_uuid() as conexao');
  await admin.query("insert into public.organizacoes (id, nome, slug, status) values ($1, $2, $3, 'active')", [org, `M6 ${sufixo}`, `m6-${sufixo}-${org.slice(0, 8)}`]);
  await admin.query("insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values ($1, $2, 'chatwoot', $3, 'conectado')", [conexao, org, sufixo]);
  return { org, conexao };
}

/** Oito workers em laço até não haver o que reivindicar. */
async function drenar(pool, comandoDe, { limite = 5 } = {}) {
  const reivindicados = [];
  const erros = [];
  const disposicoes = [];
  await Promise.all(pool.slice(0, WORKERS).map(async (client, i) => {
    const worker = `w-${i}`;
    for (;;) {
      const lote = await reivindicar(client, worker, limite);
      if (lote.length === 0) return;
      for (const evento of lote) {
        reivindicados.push(evento.evento_id);
        try {
          const r = await aplicar(client, evento.evento_id, worker, evento.fencing_token, comandoDe(evento));
          disposicoes.push(r.disposicao);
        } catch (cause) {
          erros.push(cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'desconhecido');
        }
      }
    }
  }));
  return { reivindicados, erros, disposicoes };
}

async function doisWorkers({ admin, pool, clientA }) {
  const { org, conexao } = await novaOrganizacao(admin, 'dois');
  const comandos = new Map();
  for (let i = 0; i < 120; i += 1) {
    const r = await aceitar(clientA, org, conexao, `v2:message_created:msg:${1000 + i}`);
    comandos.set(r.evento_id, comandoDaMensagem(1000 + i, 100 + (i % 12), 50 + (i % 12)));
  }
  const { reivindicados, erros, disposicoes } = await drenar(pool, (e) => comandos.get(e.evento_id));
  const casos = await casosDe(admin, org);
  const { rows: [auditoria] } = await admin.query(
    "select count(*)::int as n from public.eventos_auditoria_sistema where acao = 'sac.case_opened' and organizacao_id = $1", [org]);
  const { rows: [estado] } = await admin.query(
    `select count(*) filter (where status = 'processed')::int as processados, max(fencing_token)::int as token, max(attempts)::int as tentativas
       from public.inbox_eventos_chatwoot where organizacao_id = $1`, [org]);
  if (new Set(reivindicados).size !== 120 || reivindicados.length !== 120 || erros.length > 0 || casos !== 12
      || auditoria.n !== 12 || estado.processados !== 120 || estado.token !== 1 || estado.tentativas !== 1) {
    return err('ConsumidorDoisWorkersIncorreto', 'Workers concorrentes fora do esperado', {
      reivindicados: reivindicados.length, unicos: new Set(reivindicados).size, erros: [...new Set(erros)], casos, auditoria: auditoria.n, estado,
    });
  }
  const abertos = disposicoes.filter((d) => d === 'caso_aberto').length;
  return ok({ resumo: `8 workers em 120 eventos: cada um reivindicado uma vez, token 1, ${abertos} casos, 0 erros` });
}

async function mesmaConversa({ admin, pool, clientA }) {
  const { org, conexao } = await novaOrganizacao(admin, 'conv');
  const comandos = new Map();
  for (let i = 0; i < 40; i += 1) {
    const r = await aceitar(clientA, org, conexao, `v2:message_created:msg:${2000 + i}`);
    comandos.set(r.evento_id, comandoDaMensagem(2000 + i, 200, 60));
  }
  const { erros, disposicoes } = await drenar(pool, (e) => comandos.get(e.evento_id), { limite: 2 });
  const casos = await casosDe(admin, org);
  const abertos = disposicoes.filter((d) => d === 'caso_aberto').length;
  const somadas = disposicoes.filter((d) => d === 'mensagem_no_caso').length;
  if (erros.length > 0 || casos !== 1 || abertos !== 1 || somadas !== 39) {
    return err('ConsumidorMesmaConversaIncorreta', 'Mesma conversa fora do esperado', { erros: [...new Set(erros)], casos, abertos, somadas });
  }
  return ok({ resumo: '40 mensagens da mesma conversa em 8 workers: 1 caso, 39 somadas, 0 erros' });
}

async function quedaAntesDoCommit({ admin, clientA, novoCliente }) {
  const { org, conexao } = await novaOrganizacao(admin, 'queda');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:3000');
  const vitima = await novoCliente();
  const [claim] = await reivindicar(vitima, 'w-vitima');
  if (claim?.evento_id !== evento) return err('ConsumidorClaimIncorreto', 'Claim não devolveu o evento', { claim });

  await vitima.query('BEGIN');
  await aplicar(vitima, evento, 'w-vitima', claim.fencing_token, comandoDaMensagem(3000, 300, 70));
  const { rows: [{ pid }] } = await vitima.query('select pg_backend_pid() as pid');
  const emVoo = await casosDe(admin, org);
  await admin.query('select pg_terminate_backend($1)', [pid]);
  // A conexão caiu com a transação aberta; dar tempo ao Postgres de abortar.
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await admin.query('select 1 from pg_stat_activity where pid = $1', [pid]);
    if (rows.length === 0) break;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }

  const { rows: [resto] } = await admin.query(
    `select (select count(*)::int from public.chatwoot_contacts where organizacao_id = $1) as contatos,
            (select count(*)::int from public.chatwoot_conversations where organizacao_id = $1) as conversas,
            (select count(*)::int from public.chatwoot_messages where organizacao_id = $1) as mensagens,
            (select count(*)::int from public.sac_cases where organizacao_id = $1) as casos,
            (select count(*)::int from public.eventos_auditoria_sistema where organizacao_id = $1) as auditoria`, [org]);
  const depois = await linhaDo(admin, evento);
  if (emVoo !== 0 || resto.contatos + resto.conversas + resto.mensagens + resto.casos + resto.auditoria !== 0 || depois.status !== 'processing') {
    return err('ConsumidorQuedaDeixouParcial', 'Queda antes do commit deixou estado parcial', { emVoo, resto, depois });
  }

  const cedo = await reivindicar(clientA, 'w-cedo');
  if (cedo.some((e) => e.evento_id === evento)) return err('ConsumidorRetomouCedo', 'Evento retomado com a lease viva', {});
  await vencerLease(admin, evento);
  const [retomada] = await reivindicar(clientA, 'w-novo');
  const aplicado = await aplicar(clientA, evento, 'w-novo', retomada.fencing_token, comandoDaMensagem(3000, 300, 70));
  const casos = await casosDe(admin, org);
  if (Number(retomada.fencing_token) !== 2 || aplicado.disposicao !== 'caso_aberto' || casos !== 1) {
    return err('ConsumidorRecuperacaoIncorreta', 'Recuperação depois da queda fora do esperado', { retomada, aplicado, casos });
  }
  return ok({ resumo: 'conexão morta antes do commit: 0 contatos, conversas, mensagens, casos e auditorias; retomada com token 2 abre 1 caso' });
}

async function quedaDepoisDoCommit({ admin, clientA }) {
  const { org, conexao } = await novaOrganizacao(admin, 'ack');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:3100');
  const [claim] = await reivindicar(clientA, 'w-ack');
  await aplicar(clientA, evento, 'w-ack', claim.fencing_token, comandoDaMensagem(3100, 310, 71));
  // O worker morre sem ler a resposta: o reinício só pode descobrir pelo banco.
  await vencerLease(admin, evento);
  const retomada = await reivindicar(clientA, 'w-reinicio');
  const reaplicado = await aplicar(clientA, evento, 'w-ack', claim.fencing_token, comandoDaMensagem(3100, 310, 71));
  const casos = await casosDe(admin, org);
  if (retomada.some((e) => e.evento_id === evento) || reaplicado.desfecho !== 'posse_perdida' || casos !== 1) {
    return err('ConsumidorRepetiuDepoisDoCommit', 'Efeito repetido depois do commit', { retomada: retomada.length, reaplicado, casos });
  }
  return ok({ resumo: 'queda depois do commit: não é reivindicado de novo; 1 caso' });
}

async function zumbi({ admin, clientA, clientB }) {
  const { org, conexao } = await novaOrganizacao(admin, 'zumbi');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:3200');
  const [antigo] = await reivindicar(clientA, 'w-velho');
  await vencerLease(admin, evento);
  const [novo] = await reivindicar(clientB, 'w-novo');
  const cercado = await aplicar(clientA, evento, 'w-velho', antigo.fencing_token, comandoDaMensagem(3200, 320, 72));
  const dono = await aplicar(clientB, evento, 'w-novo', novo.fencing_token, comandoDaMensagem(3200, 320, 72));
  const casos = await casosDe(admin, org);
  if (cercado.desfecho !== 'posse_perdida' || dono.disposicao !== 'caso_aberto' || casos !== 1) {
    return err('ConsumidorZumbiNaoCercado', 'Worker com lease vencida não foi cercado', { cercado, dono, casos });
  }
  return ok({ resumo: 'worker pausado com lease vencida: cercado; o novo dono abre 1 caso' });
}

async function leaseVenceComTransacaoAberta({ admin, clientA, clientB }) {
  const { org, conexao } = await novaOrganizacao(admin, 'trava');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:3300');
  const [claim] = await reivindicar(clientA, 'w-lento');
  // A lease vence logo depois da conferência: a aplicação segura a linha aberta.
  await admin.query("update public.inbox_eventos_chatwoot set lease_expires_at = clock_timestamp() + interval '700 milliseconds' where id = $1", [evento]);
  await clientA.query('BEGIN');
  try {
    const aplicado = await aplicar(clientA, evento, 'w-lento', claim.fencing_token, comandoDaMensagem(3300, 330, 73));
    await new Promise((resolve) => { setTimeout(resolve, 900); });
    const { rows: [{ vencida }] } = await admin.query(
      'select lease_expires_at <= clock_timestamp() as vencida from public.inbox_eventos_chatwoot where id = $1', [evento]);
    const durante = await reivindicar(clientB, 'w-oportunista');
    if (aplicado.disposicao !== 'caso_aberto' || !vencida || durante.some((e) => e.evento_id === evento)) {
      await clientA.query('ROLLBACK');
      return err('ConsumidorTomouLinhaTravada', 'Evento tomado com a transação aberta', { aplicado, vencida });
    }
  } catch (cause) {
    await clientA.query('ROLLBACK');
    throw cause;
  }
  await clientA.query('COMMIT');
  const depois = await reivindicar(clientB, 'w-oportunista');
  const casos = await casosDe(admin, org);
  if (depois.some((e) => e.evento_id === evento) || casos !== 1) {
    return err('ConsumidorLinhaTravadaIncorreto', 'Depois do commit o evento voltou ou duplicou', { casos });
  }
  return ok({ resumo: 'lease vence com a transação aberta: `skip locked` impede o takeover; 1 caso' });
}

async function redelivery({ admin, clientA, clientB, timeoutDeObservacaoMs }) {
  const { org, conexao } = await novaOrganizacao(admin, 'redel');
  const chave = 'v2:message_created:msg:3400';
  const { evento_id: evento } = await aceitar(clientA, org, conexao, chave);
  const [claim] = await reivindicar(clientA, 'w-redel');
  await clientA.query('BEGIN');
  await aplicar(clientA, evento, 'w-redel', claim.fencing_token, comandoDaMensagem(3400, 340, 74));
  // A entrega repetida espera o commit em curso no `on conflict`, e aí vê o desfecho.
  const pidB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const durante = aceitar(clientB, org, conexao, chave);
  const observacao = await observarBloqueioNoPostgres(admin, pidB, { timeoutMs: timeoutDeObservacaoMs });
  await clientA.query('COMMIT');
  const repetida = await durante;
  const depois = await aceitar(clientB, org, conexao, chave);
  const { rows: [{ eventos }] } = await admin.query(
    'select count(*)::int as eventos from public.inbox_eventos_chatwoot where organizacao_id = $1', [org]);
  const retomada = await reivindicar(clientB, 'w-redel-2');
  const casos = await casosDe(admin, org);
  if (!observacao.observado || !repetida.is_duplicate || repetida.status !== 'processed' || !depois.is_duplicate
      || depois.status !== 'processed' || eventos !== 1 || casos !== 1 || retomada.some((e) => e.evento_id === evento)) {
    return err('ConsumidorRedeliveryIncorreto', 'Redelivery fora do esperado', { observacao, repetida, depois, eventos, casos });
  }
  return ok({ resumo: 'redelivery durante o consumo espera o commit e vê processed; depois também: 1 evento, 1 caso, sem novo claim' });
}

async function desligar({ admin, clientA, clientB, timeoutDeObservacaoMs }) {
  const { org, conexao } = await novaOrganizacao(admin, 'desl');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:3500');
  const [claim] = await reivindicar(clientA, 'w-desl');
  await clientA.query('BEGIN');
  await aplicar(clientA, evento, 'w-desl', claim.fencing_token, comandoDaMensagem(3500, 350, 75));
  const pidB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const desligando = clientB.query("update public.conexoes_integracao set status = 'desconectado' where id = $1", [conexao]);
  const observacao = await observarBloqueioNoPostgres(admin, pidB, { timeoutMs: timeoutDeObservacaoMs });
  await clientA.query('COMMIT');
  await desligando;
  if (!observacao.observado) return err('ConsumidorDesligarNaoEsperou', 'O desligamento não esperou o consumo', {});

  // Evento gravado antes do desligamento, pelo caminho da tabela, fica parado.
  await admin.query(
    `insert into public.inbox_eventos_chatwoot (organizacao_id, conexao_id, idempotency_key, event_type, payload)
     values ($1, $2, 'parado', 'message_created', '{}'::jsonb)`, [org, conexao]);
  const lote = await reivindicar(clientA, 'w-desl-2');
  if (lote.some((e) => e.organizacao_id === org)) return err('ConsumidorConsumiuDesligada', 'Conexão desligada foi consumida', {});
  return ok({ resumo: 'desligar esperou o consumo em curso; evento da conexão desligada não é reivindicado' });
}

async function organizacoes({ admin, pool, clientA }) {
  const comandos = new Map();
  for (let i = 0; i < 20; i += 1) {
    for (const [org, conexao] of [[ORG_A, A1], [ORG_B, B1]]) {
      const r = await aceitar(clientA, org, conexao, `v2:message_created:msg:${4000 + i}`);
      comandos.set(r.evento_id, comandoDaMensagem(4000 + i, 400, 80));
    }
  }
  const { erros } = await drenar(pool, (e) => comandos.get(e.evento_id));
  const { rows: linhas } = await admin.query(
    `select s.organizacao_id, v.conexao_id, count(*)::int as casos
       from public.sac_cases s
       join public.chatwoot_conversations v on v.id_local = s.conversa_id_local and v.organizacao_id = s.organizacao_id
      where s.organizacao_id in ($1, $2)
      group by 1, 2 order by 1`, [ORG_A, ORG_B]);
  const { rows: [{ mensagens }] } = await admin.query(
    `select count(*)::int as mensagens from public.chatwoot_messages m
       join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
      where m.organizacao_id in ($1, $2) and m.organizacao_id <> v.organizacao_id`, [ORG_A, ORG_B]);
  const esperado = [[ORG_A, A1], [ORG_B, B1]];
  const certo = linhas.length === 2 && linhas.every((l, i) => l.organizacao_id === esperado[i][0] && l.conexao_id === esperado[i][1] && l.casos === 1);
  if (erros.length > 0 || !certo || mensagens !== 0) {
    return err('ConsumidorMisturouOrganizacoes', 'A e B se misturaram', { erros: [...new Set(erros)], linhas, mensagens });
  }
  return ok({ resumo: 'A e B com os mesmos ids em paralelo: 1 caso em cada, nas conexões certas' });
}

/** Troca a função por uma versão sabotada e devolve como restaurar. */
async function sabotar(admin, assinatura, trechos) {
  const { rows: [{ definicao }] } = await admin.query('select pg_get_functiondef($1::regprocedure) as definicao', [assinatura]);
  let sabotada = definicao;
  for (const [de, para] of trechos) {
    if (!sabotada.includes(de)) throw new Error(`Trecho da sabotagem não encontrado: ${de.slice(0, 60)}`);
    sabotada = sabotada.replace(de, para);
  }
  await admin.query(sabotada);
  return async () => {
    await admin.query(definicao);
  };
}

const APLICAR_SIG = 'public.aplicar_evento_inbox_chatwoot(uuid,text,bigint,jsonb)';
const CLAIM_SIG = 'public.reivindicar_eventos_inbox_chatwoot(text,integer,integer)';

async function contraprovaSemFencing({ admin, clientA, clientB }) {
  const { org, conexao } = await novaOrganizacao(admin, 'cpf');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:5000');
  const [antigo] = await reivindicar(clientA, 'w-velho');
  await vencerLease(admin, evento);
  const [novo] = await reivindicar(clientB, 'w-novo');
  const restaurar = await sabotar(admin, APLICAR_SIG, [[
    `or v_evento.lease_owner is distinct from p_worker
       or v_evento.fencing_token <> p_fencing_token
       or v_evento.lease_expires_at is null
       or v_evento.lease_expires_at <= clock_timestamp()`, '']]);
  try {
    const cercado = await aplicar(clientA, evento, 'w-velho', antigo.fencing_token, comandoDaMensagem(5000, 500, 90));
    if (cercado.desfecho !== 'aplicado') {
      return err('ContraprovaSemFencingNaoMordeu', 'Sem fencing o token velho deveria aplicar', { cercado, novo: novo.fencing_token });
    }
    return ok({ resumo: `sem fencing: o token ${antigo.fencing_token} aplicou com o token ${novo.fencing_token} vigente` });
  } finally {
    await restaurar();
  }
}

async function contraprovaSemLease({ admin, clientA, clientB }) {
  const { org, conexao } = await novaOrganizacao(admin, 'cpl');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:5100');
  const restaurar = await sabotar(admin, CLAIM_SIG, [[
    "(e.status = 'processing' and coalesce(e.lease_expires_at, '-infinity'::timestamptz) <= v_agora)",
    "e.status = 'processing'"]]);
  try {
    const [primeiro] = await reivindicar(clientA, 'w-1');
    const segundo = (await reivindicar(clientB, 'w-2')).find((e) => e.evento_id === evento);
    if (primeiro?.evento_id !== evento || !segundo) {
      return err('ContraprovaSemLeaseNaoMordeu', 'Sem lease dois workers deveriam pegar o evento', { segundo: Boolean(segundo) });
    }
    await admin.query("update public.inbox_eventos_chatwoot set status = 'failed', disposicao = 'falha_definitiva' where id = $1", [evento]);
    return ok({ resumo: 'sem lease: dois workers reivindicam o mesmo evento vivo' });
  } finally {
    await restaurar();
  }
}

/**
 * A sequência em chamadas separadas (o que o webhook fazia e o que a RPC única
 * evita): cai antes da conclusão e o caso fica sem a inbox concluída.
 */
async function contraprovaSemTransacaoUnica({ admin, clientA }) {
  const { org, conexao } = await novaOrganizacao(admin, 'cpt');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:5200');
  await reivindicar(clientA, 'w-seq');
  const { rows: [contato] } = await admin.query(
    `insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, name)
     values (91, '91', $1, $2, 'Sintetico') returning id_local`, [org, conexao]);
  const { rows: [conversa] } = await admin.query(
    `insert into public.chatwoot_conversations (id, id_externo, organizacao_id, conexao_id, contato_id_local, contact_id, status)
     values (510, '510', $1, $2, $3, 91, 'open') returning id_local`, [org, conexao, contato.id_local]);
  await admin.query('insert into public.sac_cases (organizacao_id, conversa_id_local, evento_origem_id) values ($1, $2, $3)',
    [org, conversa.id_local, evento]);
  // Queda aqui: sem a conclusão nem a auditoria.
  const linha = await linhaDo(admin, evento);
  const { rows: [{ auditoria }] } = await admin.query(
    "select count(*)::int as auditoria from public.eventos_auditoria_sistema where acao = 'sac.case_opened' and organizacao_id = $1", [org]);
  if (await casosDe(admin, org) !== 1 || linha.status !== 'processing' || auditoria !== 0) {
    return err('ContraprovaSemTransacaoNaoMordeu', 'A sequência separada deveria deixar estado parcial', { linha, auditoria });
  }
  return ok({ resumo: 'sem a transação única: caso existe com a inbox em processing e sem auditoria' });
}

async function contraprovaSemIdempotencia({ admin, clientA, clientB }) {
  const { org, conexao } = await novaOrganizacao(admin, 'cpi');
  const consumir = async (client, worker, chave, mensagem) => {
    const { evento_id: evento } = await aceitar(client, org, conexao, chave);
    const lote = await reivindicar(client, worker);
    const alvo = lote.find((e) => e.evento_id === evento);
    return aplicar(client, evento, worker, alvo.fencing_token, comandoDaMensagem(mensagem, 520, 92));
  };
  const semBusca = await sabotar(admin, APLICAR_SIG, [[
    `and (s.mensagem_origem_id_local = v_mensagem_local
                    or (s.conversa_id_local = v_conversa_local and s.phase not in ('RESOLVED', 'CLOSED', 'CANCELLED')))`,
    'and false']]);
  const { rows: indices } = await admin.query(
    `select indexname, indexdef from pg_indexes where schemaname = 'public'
      and indexname in ('uq_sac_cases_conversa_aberto', 'uq_sac_cases_mensagem_origem')`);
  let semIndice;
  let comIndice;
  try {
    // Com os índices, a função sem a busca bate no único: o banco é a última guarda.
    await consumir(clientA, 'w-1', 'v2:message_created:msg:5300', 5300);
    try {
      await consumir(clientB, 'w-2', 'legada:msg:5300', 5300);
    } catch (cause) {
      comIndice = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'desconhecido';
    }
    for (const { indexname } of indices) await admin.query(`drop index public.${indexname}`);
    await admin.query("update public.inbox_eventos_chatwoot set lease_expires_at = clock_timestamp() - interval '1 second' where organizacao_id = $1 and status = 'processing'", [org]);
    await consumir(clientB, 'w-3', 'legada-2:msg:5300', 5300);
    semIndice = await casosDe(admin, org);
    await admin.query('delete from public.sac_cases where organizacao_id = $1', [org]);
  } finally {
    await semBusca();
    for (const { indexname, indexdef } of indices) {
      const { rows } = await admin.query('select to_regclass($1) as existe', [`public.${indexname}`]);
      if (rows[0].existe === null) await admin.query(indexdef);
    }
  }
  if (comIndice !== '23505' || semIndice !== 2) {
    return err('ContraprovaSemIdempotenciaNaoMordeu', 'Sem as guardas a mesma mensagem deveria abrir dois casos', { comIndice, semIndice });
  }
  return ok({ resumo: 'sem a busca, o único barra com 23505; sem a busca e sem os únicos, a mesma mensagem abre 2 casos' });
}

/**
 * @param {{ readonly timeoutDeObservacaoMs?: number }} [options] - Espera máxima pela observação do bloqueio.
 * @returns {Promise<object>} Resultado tagueado do rehearsal.
 */
export async function runConsumidorInboxRaceRehearsal({ timeoutDeObservacaoMs = 5_000 } = {}) {
  const abertos = [];
  const novoCliente = async () => {
    const client = createLocalDatabaseClient('orbita-consumidor-inbox');
    // Uma etapa mata esta conexão de propósito; sem o ouvinte o erro derruba o processo.
    client.on('error', () => {});
    await client.connect();
    await client.query('set role service_role');
    await client.query("set request.jwt.claim.role = 'service_role'");
    abertos.push(client);
    return client;
  };
  const admin = createLocalDatabaseClient('orbita-consumidor-inbox-admin');
  try {
    await admin.connect();
    // Eventos deixados por outros ensaios não entram neste consumo.
    await admin.query(
      "update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
    await admin.query(
      `insert into public.organizacoes (id, nome, slug, status) values
         ($1, 'Org A M6', 'org-a-consumidor-m6', 'active'), ($2, 'Org B M6', 'org-b-consumidor-m6', 'active')`, [ORG_A, ORG_B]);
    await admin.query(
      `insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
         ($1, $3, 'chatwoot', 'A1', 'conectado'), ($2, $4, 'chatwoot', 'B1', 'conectado')`, [A1, B1, ORG_A, ORG_B]);

    const [clientA, clientB] = await Promise.all([novoCliente(), novoCliente()]);
    const pool = await Promise.all(Array.from({ length: WORKERS }, novoCliente));
    const ctx = { admin, clientA, clientB, pool, novoCliente, timeoutDeObservacaoMs };

    const resumos = [];
    for (const etapa of [
      doisWorkers, mesmaConversa, quedaAntesDoCommit, quedaDepoisDoCommit, zumbi, leaseVenceComTransacaoAberta,
      redelivery, desligar, organizacoes,
      contraprovaSemFencing, contraprovaSemLease, contraprovaSemTransacaoUnica, contraprovaSemIdempotencia,
    ]) {
      const resultado = await etapa(ctx);
      if (resultado._tag === 'err') return resultado;
      resumos.push(resultado.value.resumo);
    }
    return ok(Object.freeze({ relato: `consumidor da inbox (MSG-006) provado no Postgres: ${resumos.join('; ')}` }));
  } catch (cause) {
    return err('ConsumidorInboxRehearsalFailed', 'Falha inesperada no rehearsal do consumidor da inbox', {}, cause);
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
