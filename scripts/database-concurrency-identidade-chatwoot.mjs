import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * MSG-002, migration 85. Prova contra Postgres real, com duas conexões como
 * `service_role` e a barreira determinística por `pg_stat_activity`, que a
 * identidade local do Chatwoot não mistura instalações sob concorrência:
 *
 * 1. o webhook da organização A grava o contato 5 e segura a linha; o webhook
 *    da organização B, com o mesmo id 5, espera e, depois do commit, é
 *    recusado com 23514 — o contato 5 continua de A, com o UUID de A;
 * 2. um backfill segura a trava consultiva; o segundo espera e, depois do
 *    commit, não encontra nada para fazer — nenhuma linha processada duas vezes;
 * 3. o backfill segura o contato que acabou de provar na instalação 1; o
 *    webhook da instalação 2 da mesma organização, com o mesmo id, espera e,
 *    depois do commit, é recusado com 23514 — a conexão provada não troca.
 */

const ORG_A = 'e2200000-0000-4000-8000-00000000000a';
const ORG_B = 'e2200000-0000-4000-8000-00000000000b';
const CONEXAO_A1 = 'e2200000-0000-4000-8000-0000000000c1';
const CONEXAO_A2 = 'e2200000-0000-4000-8000-0000000000c2';
const CONEXAO_B1 = 'e2200000-0000-4000-8000-0000000000c3';

async function semear(client) {
  await client.query(
    `insert into public.organizacoes (id, nome, slug, status) values
       ($1, 'Org A Identidade', 'org-a-identidade', 'active'), ($2, 'Org B Identidade', 'org-b-identidade', 'active')`,
    [ORG_A, ORG_B],
  );
  await client.query(
    `insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
       ($1, $4, 'chatwoot', 'Principal', 'conectado'), ($2, $4, 'chatwoot', 'Segunda', 'conectado'),
       ($3, $5, 'chatwoot', 'Principal', 'conectado')`,
    [CONEXAO_A1, CONEXAO_A2, CONEXAO_B1, ORG_A, ORG_B],
  );
  await client.query(
    "insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id) values ($1, $2, 1, '1')",
    [ORG_A, CONEXAO_A1],
  );
  // O sync de hoje: contatos 21 e 22 sem conexão, conversas no inbox 1 (prova c1).
  await client.query(
    `insert into public.chatwoot_contacts (id, organizacao_id, name) values (21, $1, 'Sync 21'), (22, $1, 'Sync 22')`,
    [ORG_A],
  );
  await client.query(
    `insert into public.chatwoot_conversations (id, organizacao_id, contact_id, status, inbox_id)
     values (210, $1, 21, 'open', 1), (220, $1, 22, 'open', 1)`,
    [ORG_A],
  );
}

async function executar(client, sql, params) {
  try {
    return { ok: true, linhas: (await client.query(sql, params)).rows };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined };
  }
}

/** A abre transação e executa; B dispara sem esperar; o Postgres mostra B bloqueada; só então A commita. */
async function correr({ admin, clientA, clientB, sqlA, paramsA, sqlB, paramsB, timeoutDeObservacaoMs }) {
  await clientA.query('BEGIN');
  const a = await executar(clientA, sqlA, paramsA);
  if (!a.ok) {
    await clientA.query('ROLLBACK');
    return err('IdentidadeChatwootRaceInicioFalhou', 'A primeira chamada falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('IdentidadeChatwootRaceNaoBloqueou', 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linhas, b: await promiseB, waitEvent: observacao.waitEvent });
}

/** O upsert do webhook (`chatwootWebhookPersistence`), pela PK legada. */
const SQL_UPSERT_CONTATO = `insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
  values ($1, $2, $3, $4)
  on conflict (id) do update set organizacao_id = excluded.organizacao_id, conexao_id = excluded.conexao_id, name = excluded.name`;
const SQL_BACKFILL = 'select tabela, atualizadas from public.backfill_identidade_local_chatwoot(1000)';

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runIdentidadeChatwootRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-identidade-chatwoot'),
  timeoutDeObservacaoMs = 3000,
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  try {
    await admin.connect();
    await clientA.connect();
    await clientB.connect();
    await semear(admin);
    await clientA.query('set role service_role');
    await clientB.query('set role service_role');

    const colisao = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_UPSERT_CONTATO, paramsA: [5, ORG_A, CONEXAO_A1, 'Contato de A'],
      sqlB: SQL_UPSERT_CONTATO, paramsB: [5, ORG_B, CONEXAO_B1, 'Contato de B'],
    });
    if (colisao._tag === 'err') return colisao;
    const contato5 = (await admin.query(
      'select organizacao_id, conexao_id, name, count(*) over () as n from public.chatwoot_contacts where id = 5')).rows;
    if (colisao.value.b.ok || colisao.value.b.code !== '23514' || contato5.length !== 1
        || contato5[0].organizacao_id !== ORG_A || contato5[0].name !== 'Contato de A') {
      return err('IdentidadeChatwootRaceMisturou', 'O webhook concorrente de B tomou o contato 5 de A', { b: colisao.value.b, contato5 });
    }

    const backfills = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_BACKFILL, paramsA: [],
      sqlB: SQL_BACKFILL, paramsB: [],
    });
    if (backfills._tag === 'err') return backfills;
    const totalA = backfills.value.a.reduce((soma, linha) => soma + linha.atualizadas, 0);
    const totalB = backfills.value.b.ok ? backfills.value.b.linhas.reduce((soma, linha) => soma + linha.atualizadas, 0) : -1;
    const provados = (await admin.query(
      'select count(*)::int as n from public.chatwoot_contacts where id in (21, 22) and conexao_id = $1', [CONEXAO_A1])).rows[0].n;
    if (totalA !== 2 || totalB !== 0 || provados !== 2) {
      return err('IdentidadeChatwootRaceBackfillDuplo', 'Dois backfills concorrentes não se serializaram', { totalA, b: backfills.value.b, provados });
    }

    // O contato 23 nasce sem conexão; o backfill o prova em c1 e segura a linha.
    await admin.query("insert into public.chatwoot_contacts (id, organizacao_id, name) values (23, $1, 'Sync 23')", [ORG_A]);
    await admin.query("insert into public.chatwoot_conversations (id, organizacao_id, contact_id, status, inbox_id) values (230, $1, 23, 'open', 1)", [ORG_A]);
    const uuidAntes = (await admin.query('select id_local from public.chatwoot_contacts where id = 23')).rows[0].id_local;
    const instalacoes = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_BACKFILL, paramsA: [],
      sqlB: SQL_UPSERT_CONTATO, paramsB: [23, ORG_A, CONEXAO_A2, 'Contato da segunda instalação'],
    });
    if (instalacoes._tag === 'err') return instalacoes;
    const contato23 = (await admin.query('select conexao_id, name, id_local from public.chatwoot_contacts where id = 23')).rows[0];
    if (instalacoes.value.b.ok || instalacoes.value.b.code !== '23514' || contato23.conexao_id !== CONEXAO_A1
        || contato23.name !== 'Sync 23' || contato23.id_local !== uuidAntes) {
      return err('IdentidadeChatwootRaceTrocouInstalacao', 'O webhook da segunda instalação tomou o contato provado na primeira', {
        b: instalacoes.value.b, contato23,
      });
    }

    return ok(Object.freeze({
      relato: 'identidade local do Chatwoot provada com bloqueio observado no Postgres: webhook de A → webhook de B com o '
        + `mesmo id (wait_event=${colisao.value.waitEvent}) recusado com ${colisao.value.b.code}, contato 5 continua de A; `
        + `dois backfills (wait_event=${backfills.value.waitEvent}) processaram ${totalA} e ${totalB} linhas; backfill → webhook `
        + `da segunda instalação (wait_event=${instalacoes.value.waitEvent}) recusado com ${instalacoes.value.b.code}, `
        + 'conexão e UUID do contato preservados',
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('IdentidadeChatwootRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência da identidade Chatwoot', {}, cause);
  } finally {
    for (const client of [admin, clientA, clientB]) {
      try {
        await client.end();
      } catch {
        // Encerramento de conexão de teste; nada a fazer se já caiu.
      }
    }
  }
}
