import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * MSG-004. Prova contra Postgres real, como `service_role`, que sem a chave
 * global duas instalações com os mesmos ids remotos não se bloqueiam nem se
 * misturam, e que a mesma instalação continua deduplicando:
 *
 * 1. inbox de eventos: A1 registra `msg_500_conv_50` e segura a transação; A2,
 *    com a mesma chave, registra o seu sem esperar. A1 de novo, em paralelo, na
 *    mesma chave: espera, recebe 23505 (o webhook responde 500 e o Chatwoot
 *    reentrega) e a reentrega é a duplicata do evento de A1;
 * 2. webhook: as três instalações gravam contato 5, conversa 50 e mensagem 500
 *    em transações abertas ao mesmo tempo, sem esperar; a mesma mensagem 500 de
 *    A2 entregue duas vezes em paralelo: a segunda espera e recebe 23505 (o
 *    `gravar` relê e atualiza) — três árvores, uma linha por instalação;
 * 3. retenção × webhook: a exclusão do contato 5 de A1 segura a linha (e a
 *    cascata); o webhook de A2 atualiza o seu contato 5 e a sua mensagem 500
 *    sem esperar. Depois do commit, A1 sumiu e A2 e B1 seguem intactos.
 */

const ORG_A = 'e4400000-0000-4000-8000-00000000000a';
const ORG_B = 'e4400000-0000-4000-8000-00000000000b';
const A1 = 'e4400000-0000-4000-8000-0000000000c1';
const A2 = 'e4400000-0000-4000-8000-0000000000c2';
const B1 = 'e4400000-0000-4000-8000-0000000000c3';
const RUN = 'e4400000-0000-4000-8000-0000000000f1';
const ESCOPOS = [[ORG_A, A1], [ORG_A, A2], [ORG_B, B1]];
const CHAVE = 'event_message_created_msg_500_conv_50';

async function semear(client) {
  await client.query(
    `insert into public.organizacoes (id, nome, slug, status) values
       ($1, 'Org A Contracao', 'org-a-contracao', 'active'), ($2, 'Org B Contracao', 'org-b-contracao', 'active')`,
    [ORG_A, ORG_B],
  );
  await client.query(
    `insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
       ($1, $4, 'chatwoot', 'A1', 'conectado'), ($2, $4, 'chatwoot', 'A2', 'conectado'), ($3, $5, 'chatwoot', 'B1', 'conectado')`,
    [A1, A2, B1, ORG_A, ORG_B],
  );
  await client.query(
    `insert into public.retention_runs (id, organizacao_id, categoria, policy_versao, modo, cutoff)
     values ($1, $2, 'chatwoot_contato_inativo', 1, 'execute', now())`,
    [RUN, ORG_A],
  );
}

async function executar(client, sql, params) {
  try {
    return { ok: true, linhas: (await client.query(sql, params)).rows };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined };
  }
}

/** Executa uma sequência de instruções; para na primeira falha. */
async function sequencia(client, passos) {
  const linhas = [];
  for (const [sql, params] of passos) {
    const r = await executar(client, sql, params);
    if (!r.ok) return r;
    linhas.push(r.linhas);
  }
  return { ok: true, linhas };
}

/** A segura a transação; B tem de concluir antes de A commitar. */
async function semEsperar({ clientA, clientB, passosA, passosB, timeoutDeObservacaoMs }) {
  await clientA.query('BEGIN');
  const a = await sequencia(clientA, passosA);
  if (!a.ok) {
    await clientA.query('ROLLBACK');
    return err('ContracaoChatwootInicioFalhou', 'A primeira escrita falhou antes da concorrência', { a });
  }
  const b = await Promise.race([sequencia(clientB, passosB), esperar(timeoutDeObservacaoMs).then(() => undefined)]);
  if (b === undefined) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('ContracaoChatwootBloqueou', 'B esperou A: ainda há chave comum entre instalações', {});
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linhas, b });
}

/** A segura a transação; B dispara; o Postgres mostra B bloqueada; só então A commita. */
async function comEspera({ admin, clientA, clientB, passosA, passosB, timeoutDeObservacaoMs }) {
  await clientA.query('BEGIN');
  const a = await sequencia(clientA, passosA);
  if (!a.ok) {
    await clientA.query('ROLLBACK');
    return err('ContracaoChatwootInicioFalhou', 'A primeira escrita falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = sequencia(clientB, passosB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('ContracaoChatwootNaoBloqueou', 'B nunca apareceu esperando um Lock', {});
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linhas, b: await promiseB, waitEvent: observacao.waitEvent });
}

const SQL_EVENTO = `select evento_id, is_duplicate from public.registrar_evento_inbox_chatwoot(
  $1, $2, null, 1, $3, 'message_created', '{}'::jsonb)`;

/** As escritas do store para uma árvore 5/50/500 numa instalação. */
function arvore(org, conexao) {
  return [
    [`insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, name)
      values (5, '5', $1, $2, 'contato 5') returning id_local`, [org, conexao]],
    [`insert into public.chatwoot_conversations (id, id_externo, organizacao_id, conexao_id, contact_id, contato_id_local, status)
      select 50, '50', $1, $2, 5, c.id_local, 'open' from public.chatwoot_contacts c
       where c.organizacao_id = $1 and c.conexao_id = $2 and c.id_externo = '5' returning id_local`, [org, conexao]],
    [`insert into public.chatwoot_messages (id, id_externo, organizacao_id, conexao_id, conversation_id, conversa_id_local, content)
      select 500, '500', $1, $2, 50, v.id_local, $3 from public.chatwoot_conversations v
       where v.organizacao_id = $1 and v.conexao_id = $2 and v.id_externo = '50' returning id_local`, [org, conexao, `500 de ${conexao}`]],
  ];
}

/** 1. Inbox de eventos. */
async function eventos(ctx) {
  const entreInstalacoes = await semEsperar({
    ...ctx, passosA: [[SQL_EVENTO, [ORG_A, A1, CHAVE]]], passosB: [[SQL_EVENTO, [ORG_A, A2, CHAVE]]],
  });
  if (entreInstalacoes._tag === 'err') return entreInstalacoes;
  const [[eventoA1]] = entreInstalacoes.value.a;
  const [[eventoA2]] = entreInstalacoes.value.b.linhas;
  if (eventoA1.is_duplicate || eventoA2.is_duplicate || eventoA1.evento_id === eventoA2.evento_id) {
    return err('ContracaoChatwootEventoFundido', 'O evento de A2 virou duplicata do de A1', { eventoA1, eventoA2 });
  }

  const mesmaInstalacao = await comEspera({
    ...ctx,
    passosA: [[SQL_EVENTO, [ORG_A, A1, 'event_message_updated_msg_500_conv_50']]],
    passosB: [[SQL_EVENTO, [ORG_A, A1, 'event_message_updated_msg_500_conv_50']]],
  });
  if (mesmaInstalacao._tag === 'err') return mesmaInstalacao;
  const reentrega = await executar(ctx.clientB, SQL_EVENTO, [ORG_A, A1, 'event_message_updated_msg_500_conv_50']);
  if (mesmaInstalacao.value.b.ok || mesmaInstalacao.value.b.code !== '23505' || !reentrega.ok
      || !reentrega.linhas[0].is_duplicate || reentrega.linhas[0].evento_id !== mesmaInstalacao.value.a[0][0].evento_id) {
    return err('ContracaoChatwootEventoDuplicou', 'A mesma instalação registrou o mesmo evento duas vezes', {
      b: mesmaInstalacao.value.b, reentrega,
    });
  }
  return ok({ resumo: `eventos: A1 e A2 com a mesma chave sem esperar; A1 duas vezes (wait_event=${mesmaInstalacao.value.waitEvent}) → 23505 → reentrega duplicata` });
}

/** 2. Árvores do webhook. */
async function webhook(ctx) {
  const { admin, clientA, clientB, timeoutDeObservacaoMs } = ctx;
  const terceiro = ctx.terceiro;
  await terceiro.query('BEGIN');
  const b1 = await sequencia(terceiro, arvore(ORG_B, B1));
  const paralelas = await semEsperar({ clientA, clientB, timeoutDeObservacaoMs, passosA: arvore(ORG_A, A1), passosB: arvore(ORG_A, A2) });
  await terceiro.query(b1.ok ? 'COMMIT' : 'ROLLBACK');
  if (!b1.ok) return err('ContracaoChatwootArvoreFalhou', 'A árvore de B1 não gravou', { b1 });
  if (paralelas._tag === 'err') return paralelas;
  if (!paralelas.value.b.ok) return err('ContracaoChatwootArvoreFalhou', 'A árvore de A2 não gravou em paralelo à de A1', { b: paralelas.value.b });

  const repetida = `insert into public.chatwoot_messages (id, id_externo, organizacao_id, conexao_id, conversation_id, conversa_id_local, content)
    select 500, '500', $1, $2, 50, v.id_local, 'reentrega' from public.chatwoot_conversations v
     where v.organizacao_id = $1 and v.conexao_id = $2 and v.id_externo = '50' returning id_local`;
  await admin.query('BEGIN');
  await admin.query(`delete from public.chatwoot_messages where organizacao_id = $1 and conexao_id = $2 and id_externo = '500'`, [ORG_A, A2]);
  await admin.query('COMMIT');
  const duplicada = await comEspera({ ...ctx, passosA: [[repetida, [ORG_A, A2]]], passosB: [[repetida, [ORG_A, A2]]] });
  if (duplicada._tag === 'err') return duplicada;

  const linhas = (await admin.query(
    `select m.conexao_id, count(*)::int as n,
            bool_and(m.conexao_id = v.conexao_id and v.conexao_id = c.conexao_id and m.organizacao_id = c.organizacao_id) as coerente
       from public.chatwoot_messages m
       join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
       join public.chatwoot_contacts c on c.id_local = v.contato_id_local
      where m.id_externo = '500' and m.organizacao_id in ($1, $2)
      group by m.conexao_id`, [ORG_A, ORG_B])).rows;
  const porInstalacao = Object.fromEntries(linhas.map((l) => [l.conexao_id, l]));
  if (duplicada.value.b.ok || duplicada.value.b.code !== '23505'
      || ESCOPOS.some(([, conexao]) => porInstalacao[conexao]?.n !== 1 || !porInstalacao[conexao]?.coerente)) {
    return err('ContracaoChatwootArvoreMisturou', 'As árvores 5/50/500 não ficaram uma por instalação', { b: duplicada.value.b, linhas });
  }
  return ok({ resumo: `webhook: três árvores 5/50/500 em paralelo sem esperar; a 500 de A2 duas vezes (wait_event=${duplicada.value.waitEvent}) → 23505 → 1 linha por instalação` });
}

/** 3. Retenção × webhook. */
async function retencao(ctx) {
  const { admin } = ctx;
  const contato = async (conexao) => (await admin.query(
    "select id_local from public.chatwoot_contacts where conexao_id = $1 and id_externo = '5'", [conexao])).rows[0]?.id_local;
  const contatoA1 = await contato(A1);
  const contatoA2 = await contato(A2);
  const corrida = await semEsperar({
    ...ctx,
    passosA: [[`select public.retencao_aplicar_exclusao($1, $2, 'chatwoot_contato_inativo', 'chatwoot_contacts', $3) as aplicado`,
               [RUN, ORG_A, contatoA1]]],
    passosB: [
      [`update public.chatwoot_contacts set name = 'webhook de A2' where organizacao_id = $1 and id_local = $2 and conexao_id = $3 returning id_local`,
       [ORG_A, contatoA2, A2]],
      [`update public.chatwoot_messages set content = 'editada em A2' where organizacao_id = $1 and conexao_id = $2 and id_externo = '500' returning id_local`,
       [ORG_A, A2]],
    ],
  });
  if (corrida._tag === 'err') return corrida;
  const restantes = (await admin.query(
    `select c.conexao_id, c.name, (select count(*)::int from public.chatwoot_messages m where m.conexao_id = c.conexao_id and m.id_externo = '500') as mensagens
       from public.chatwoot_contacts c where c.id_externo = '5' and c.organizacao_id in ($1, $2) order by c.conexao_id`,
    [ORG_A, ORG_B])).rows;
  const esperado = JSON.stringify([
    { conexao_id: A2, name: 'webhook de A2', mensagens: 1 },
    { conexao_id: B1, name: 'contato 5', mensagens: 1 },
  ]);
  if (!corrida.value.b.ok || corrida.value.b.linhas.some((l) => l.length !== 1) || JSON.stringify(restantes) !== esperado) {
    return err('ContracaoChatwootRetencaoCruzou', 'A exclusão de A1 tocou ou bloqueou outra instalação', { b: corrida.value.b, restantes });
  }
  return ok({ resumo: 'retenção: excluir o contato 5 de A1 não bloqueia nem toca o 5 de A2 e de B1 (cascata só na árvore de A1)' });
}

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runContracaoChatwootRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-contracao-chatwoot'),
  timeoutDeObservacaoMs = 3000,
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  const terceiro = createClient();
  try {
    for (const client of [admin, clientA, clientB, terceiro]) await client.connect();
    await semear(admin);
    for (const client of [clientA, clientB, terceiro]) await client.query('set role service_role');
    const ctx = { admin, clientA, clientB, terceiro, timeoutDeObservacaoMs };

    const resumos = [];
    for (const etapa of [eventos, webhook, retencao]) {
      const resultado = await etapa(ctx);
      if (resultado._tag === 'err') return resultado;
      resumos.push(resultado.value.resumo);
    }
    return ok(Object.freeze({ relato: `contração do Chatwoot (MSG-004) provada no Postgres: ${resumos.join('; ')}` }));
  } catch (cause) {
    for (const client of [clientA, terceiro]) await client.query('ROLLBACK').catch(() => {});
    return err('ContracaoChatwootRehearsalFailed', 'Falha inesperada no rehearsal da contração Chatwoot', {}, cause);
  } finally {
    for (const client of [admin, clientA, clientB, terceiro]) {
      try {
        await client.end();
      } catch {
        // Encerramento de conexão de teste; nada a fazer se já caiu.
      }
    }
  }
}
