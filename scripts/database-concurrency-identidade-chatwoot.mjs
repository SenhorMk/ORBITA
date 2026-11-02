import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { correr as correrBase, fabricarLegado as fabricar, semEsperar as semEsperarBase } from './database-concurrency-chatwoot.mjs';

/**
 * MSG-002 (migration 85), no schema contraído do MSG-004. Prova contra Postgres
 * real, com duas conexões como `service_role` e a barreira determinística por
 * `pg_stat_activity`, que a identidade local do Chatwoot não mistura
 * instalações sob concorrência:
 *
 * 1. o webhook da organização A grava o contato 5 e segura a transação; o
 *    webhook da organização B, com o mesmo id 5, NÃO espera (não há mais chave
 *    global) e grava o seu: duas linhas, dois UUIDs, cada uma na sua
 *    organização e conexão;
 * 2. um backfill segura a trava consultiva; o segundo espera e, depois do
 *    commit, não encontra nada para fazer — nenhuma linha processada duas vezes;
 * 3. o backfill segura o contato legado que acabou de provar na instalação 1; a
 *    adoção pela instalação 2 da mesma organização (o `update` do store) espera
 *    e, depois do commit, não casa mais — zero linhas, a conexão provada não
 *    troca.
 *
 * As linhas legadas (sem conexão, anteriores ao MSG-004) são fabricadas com o
 * gatilho de identidade desligado: depois do MSG-004 nenhuma escrita as cria.
 */

const ORG_A = 'e2200000-0000-4000-8000-00000000000a';
const ORG_B = 'e2200000-0000-4000-8000-00000000000b';
const CONEXAO_A1 = 'e2200000-0000-4000-8000-0000000000c1';
const CONEXAO_A2 = 'e2200000-0000-4000-8000-0000000000c2';
const CONEXAO_B1 = 'e2200000-0000-4000-8000-0000000000c3';

const ROTULO = { rotulo: 'IdentidadeChatwootRace' };
const correr = (ctx) => correrBase({ ...ctx, ...ROTULO });
const semEsperar = (ctx) => semEsperarBase({ ...ctx, ...ROTULO });

/** Contatos do sync antigo, sem conexão, cada um com a sua conversa no inbox 1. */
async function fabricarLegado(client, contatos) {
  for (const contato of contatos) {
    await fabricar(client, { organizacao: ORG_A, contato, conversa: contato * 10, inbox: 1, nome: `Sync ${contato}` });
  }
}

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
  // O sync antigo: contatos 21 e 22 sem conexão, conversas no inbox 1 (prova c1).
  await fabricarLegado(client, [21, 22]);
}

/** O `inserir` do store: id remoto, organização e conexão do escopo. */
const SQL_INSERIR_CONTATO = `insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, name)
  values ($1::int, $1::int::text, $2, $3, $4) returning id_local`;
/** O `atualizar` do store: pelo UUID local, na conexão do escopo ou linha legada. */
const SQL_ADOTAR_CONTATO = `update public.chatwoot_contacts set name = $4, conexao_id = $3
  where organizacao_id = $1 and id_local = $2 and (conexao_id = $3 or conexao_id is null) returning id_local`;
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

    const coexistencia = await semEsperar({
      clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_INSERIR_CONTATO, paramsA: [5, ORG_A, CONEXAO_A1, 'Contato de A'],
      sqlB: SQL_INSERIR_CONTATO, paramsB: [5, ORG_B, CONEXAO_B1, 'Contato de B'],
    });
    if (coexistencia._tag === 'err') return coexistencia;
    const contatos5 = (await admin.query(
      "select organizacao_id, conexao_id, name, id_local from public.chatwoot_contacts where id_externo = '5' and organizacao_id in ($1, $2) order by name",
      [ORG_A, ORG_B])).rows;
    if (!coexistencia.value.b.ok || contatos5.length !== 2
        || contatos5[0].organizacao_id !== ORG_A || contatos5[0].conexao_id !== CONEXAO_A1
        || contatos5[1].organizacao_id !== ORG_B || contatos5[1].conexao_id !== CONEXAO_B1
        || contatos5[0].id_local === contatos5[1].id_local) {
      return err('IdentidadeChatwootRaceMisturou', 'Os contatos 5 de A e B não coexistiram cada um no seu escopo', {
        b: coexistencia.value.b, contatos5,
      });
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
      "select count(*)::int as n from public.chatwoot_contacts where organizacao_id = $1 and id_externo in ('21', '22') and conexao_id = $2",
      [ORG_A, CONEXAO_A1])).rows[0].n;
    // Pelo menos os dois contatos e as suas duas conversas, provados pelo inbox 1
    // (c1); o backfill é global e pode achar legado de outro ensaio.
    if (totalA < 4 || totalB !== 0 || provados !== 2) {
      return err('IdentidadeChatwootRaceBackfillDuplo', 'Dois backfills concorrentes não se serializaram', { totalA, b: backfills.value.b, provados });
    }

    // O contato 23 é legado; o backfill o prova em c1 e segura a linha.
    await fabricarLegado(admin, [23]);
    const uuidAntes = (await admin.query(
      "select id_local from public.chatwoot_contacts where organizacao_id = $1 and id_externo = '23'", [ORG_A])).rows[0].id_local;
    const instalacoes = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_BACKFILL, paramsA: [],
      sqlB: SQL_ADOTAR_CONTATO, paramsB: [ORG_A, uuidAntes, CONEXAO_A2, 'Contato da segunda instalação'],
    });
    if (instalacoes._tag === 'err') return instalacoes;
    const contato23 = (await admin.query('select conexao_id, name, id_local from public.chatwoot_contacts where id_local = $1', [uuidAntes])).rows[0];
    if (!instalacoes.value.b.ok || instalacoes.value.b.linhas.length !== 0 || contato23.conexao_id !== CONEXAO_A1
        || contato23.name !== 'Sync 23') {
      return err('IdentidadeChatwootRaceTrocouInstalacao', 'A segunda instalação tomou o contato provado na primeira', {
        b: instalacoes.value.b, contato23,
      });
    }

    return ok(Object.freeze({
      relato: 'identidade local do Chatwoot provada no Postgres: o contato 5 de A e o de B gravam sem esperar um pelo outro '
        + '(duas linhas, dois UUIDs); '
        + `dois backfills (wait_event=${backfills.value.waitEvent}) processaram ${totalA} e ${totalB} linhas; backfill → adoção `
        + `pela segunda instalação (wait_event=${instalacoes.value.waitEvent}) casou 0 linhas, conexão e UUID do contato preservados`,
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
