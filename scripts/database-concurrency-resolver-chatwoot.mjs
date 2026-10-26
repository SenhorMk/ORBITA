import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * MSG-003A. Prova contra Postgres real, como `service_role`, que as instruções
 * do store de espelhos (`src/services/chatwoot/espelhoChatwootSupabase.ts`)
 * localizam e gravam pelo UUID local sem misturar instalações:
 *
 * Os ids ficam na faixa 330000+: a PK global ainda vale e o ensaio do MSG-002
 * deixa os contatos 5, 21 etc. no mesmo banco.
 *
 * 1. duas escritas da MESMA conexão criando o mesmo contato: a segunda espera e
 *    recebe 23505; relendo pelo resolver, encontra a linha da primeira e a
 *    atualiza — uma linha, um UUID (o caminho de retry do `gravar`);
 * 2. a organização B criando o mesmo contato enquanto A grava: B espera,
 *    recebe 23505 e, relendo no seu escopo, não encontra nada — colisão
 *    tipada; a linha de A fica intacta;
 * 3. duas instalações da mesma organização adotando a mesma linha legada sem
 *    conexão: a segunda espera e, depois do commit, o filtro de conexão do
 *    `update` não casa mais — zero linhas, a conexão provada não troca;
 * 4. mensagem ligada à conversa de outra conexão é recusada (23503) e o
 *    `authenticated` não escreve nos espelhos (42501);
 * 5. numa simulação da contração do MSG-004 (desfeita no fim), três
 *    instalações com os mesmos ids 5/50/500 gravam espelhos distintos e o
 *    resolver devolve exatamente um UUID por escopo. Contraprovas na mesma
 *    simulação: sem o filtro de conexão a busca fica ambígua (2) e por id
 *    global encontra as três; um `update` legado por `id` tocaria as três.
 */

const ORG_A = 'e3300000-0000-4000-8000-00000000000a';
const ORG_B = 'e3300000-0000-4000-8000-00000000000b';
const CONEXAO_A1 = 'e3300000-0000-4000-8000-0000000000c1';
const CONEXAO_A2 = 'e3300000-0000-4000-8000-0000000000c2';
const CONEXAO_B1 = 'e3300000-0000-4000-8000-0000000000c3';

/** `buscarPorIdExterno`: organização + id remoto + (conexão do escopo ou legado). */
const SQL_RESOLVER = (tabela) => `select id_local, conexao_id from public.${tabela}
  where organizacao_id = $1 and id_externo = $2 and (conexao_id = $3 or conexao_id is null)`;
/** `inserir` do contato. */
const SQL_INSERIR_CONTATO = `insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, name)
  values ($1::int, $1::int::text, $2, $3, $4) returning id_local`;
/** `atualizar`: pelo UUID local, na organização e na conexão do escopo (ou legado). */
const SQL_ATUALIZAR_CONTATO = `update public.chatwoot_contacts set name = $4, conexao_id = $3
  where organizacao_id = $1 and id_local = $2 and (conexao_id = $3 or conexao_id is null) returning id_local`;

async function semear(client) {
  await client.query(
    `insert into public.organizacoes (id, nome, slug, status) values
       ($1, 'Org A Resolver', 'org-a-resolver', 'active'), ($2, 'Org B Resolver', 'org-b-resolver', 'active')`,
    [ORG_A, ORG_B],
  );
  await client.query(
    `insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
       ($1, $4, 'chatwoot', 'Principal', 'conectado'), ($2, $4, 'chatwoot', 'Segunda', 'conectado'),
       ($3, $5, 'chatwoot', 'Principal', 'conectado')`,
    [CONEXAO_A1, CONEXAO_A2, CONEXAO_B1, ORG_A, ORG_B],
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
    return err('ResolverChatwootRaceInicioFalhou', 'A primeira escrita falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('ResolverChatwootRaceNaoBloqueou', 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linhas, b: await promiseB, waitEvent: observacao.waitEvent });
}

async function resolver(client, tabela, organizacao, conexao, idExterno) {
  return (await client.query(SQL_RESOLVER(tabela), [organizacao, String(idExterno), conexao])).rows;
}

/** Corridas 1 a 3. */
async function corridas(ctx) {
  const { admin, clientB } = ctx;
  const mesmaConexao = await correr({
    ...ctx,
    sqlA: SQL_INSERIR_CONTATO, paramsA: [330005, ORG_A, CONEXAO_A1, 'pelo webhook'],
    sqlB: SQL_INSERIR_CONTATO, paramsB: [330005, ORG_A, CONEXAO_A1, 'pelo sync'],
  });
  if (mesmaConexao._tag === 'err') return mesmaConexao;
  const relida = await resolver(clientB, 'chatwoot_contacts', ORG_A, CONEXAO_A1, 330005);
  const retry = relida.length === 1
    ? await executar(clientB, SQL_ATUALIZAR_CONTATO, [ORG_A, relida[0].id_local, CONEXAO_A1, 'pelo sync'])
    : { ok: false };
  const contato5 = (await admin.query('select id_local, name from public.chatwoot_contacts where id = 330005')).rows;
  if (mesmaConexao.value.b.ok || mesmaConexao.value.b.code !== '23505' || !retry.ok || retry.linhas.length !== 1
      || contato5.length !== 1 || contato5[0].id_local !== mesmaConexao.value.a[0].id_local || contato5[0].name !== 'pelo sync') {
    return err('ResolverChatwootRaceDuplicou', 'Duas escritas da mesma conexão não convergiram para uma linha', { b: mesmaConexao.value.b, contato5 });
  }

  const outraOrganizacao = await correr({
    ...ctx,
    sqlA: SQL_INSERIR_CONTATO, paramsA: [330006, ORG_A, CONEXAO_A1, 'de A'],
    sqlB: SQL_INSERIR_CONTATO, paramsB: [330006, ORG_B, CONEXAO_B1, 'de B'],
  });
  if (outraOrganizacao._tag === 'err') return outraOrganizacao;
  const noEscopoDeB = await resolver(clientB, 'chatwoot_contacts', ORG_B, CONEXAO_B1, 330006);
  const contato6 = (await admin.query('select organizacao_id, name from public.chatwoot_contacts where id = 330006')).rows;
  if (outraOrganizacao.value.b.ok || outraOrganizacao.value.b.code !== '23505' || noEscopoDeB.length !== 0
      || contato6.length !== 1 || contato6[0].organizacao_id !== ORG_A || contato6[0].name !== 'de A') {
    return err('ResolverChatwootRaceMisturou', 'B encontrou ou tomou o contato 6 de A', { b: outraOrganizacao.value.b, noEscopoDeB, contato6 });
  }

  const legado = (await admin.query(
    "insert into public.chatwoot_contacts (id, organizacao_id, name) values (330021, $1, 'Sync antigo') returning id_local", [ORG_A],
  )).rows[0].id_local;
  const adocao = await correr({
    ...ctx,
    sqlA: SQL_ATUALIZAR_CONTATO, paramsA: [ORG_A, legado, CONEXAO_A1, 'adotado por A1'],
    sqlB: SQL_ATUALIZAR_CONTATO, paramsB: [ORG_A, legado, CONEXAO_A2, 'adotado por A2'],
  });
  if (adocao._tag === 'err') return adocao;
  const contato21 = (await admin.query('select id_local, conexao_id, name from public.chatwoot_contacts where id = 330021')).rows[0];
  if (!adocao.value.b.ok || adocao.value.b.linhas.length !== 0 || contato21.conexao_id !== CONEXAO_A1
      || contato21.id_local !== legado || contato21.name !== 'adotado por A1') {
    return err('ResolverChatwootRaceTrocouAdocao', 'A segunda instalação adotou a linha já provada na primeira', { b: adocao.value.b, contato21 });
  }

  return ok({
    resumo: `mesma conexão (wait_event=${mesmaConexao.value.waitEvent}) → 23505 → releitura → 1 linha; `
      + `outra organização (wait_event=${outraOrganizacao.value.waitEvent}) → 23505 → 0 no escopo de B; `
      + `adoção legada (wait_event=${adocao.value.waitEvent}) → 0 linhas para A2`,
  });
}

/** 4: vínculo com pai de outra conexão e escrita do navegador. */
async function recusas(admin) {
  await admin.query(
    "insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name) values (330007, $1, $2, 'contato de A1')",
    [ORG_A, CONEXAO_A1],
  );
  await admin.query(
    "insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status) values (330070, $1, $2, 330007, 'open')",
    [ORG_A, CONEXAO_A1],
  );
  const conversaA1 = (await resolver(admin, 'chatwoot_conversations', ORG_A, CONEXAO_A1, 330070))[0].id_local;
  await admin.query('set role service_role');
  const cruzada = await executar(admin,
    `insert into public.chatwoot_messages (id, id_externo, organizacao_id, conexao_id, conversation_id, conversa_id_local, content)
     values (330700, '330700', $1, $2, 330070, $3, 'cruzada')`, [ORG_A, CONEXAO_A2, conversaA1]);
  await admin.query('reset role');
  await admin.query('set role authenticated');
  const navegador = await executar(admin, SQL_INSERIR_CONTATO, [330008, ORG_A, CONEXAO_A1, 'pelo navegador']);
  await admin.query('reset role');
  if (cruzada.ok || cruzada.code !== '23503' || navegador.ok || navegador.code !== '42501') {
    return err('ResolverChatwootRecusaFalhou', 'Vínculo cruzado ou escrita do navegador não foi recusado', { cruzada, navegador });
  }
  return ok({ resumo: `mensagem na conversa de outra conexão → ${cruzada.code}; authenticated grava → ${navegador.code}` });
}

/** 5: modelo depois da contração, desfeito por rollback. */
async function posContracao(admin) {
  await admin.query('BEGIN');
  try {
    await admin.query(`
      alter table public.chatwoot_messages drop constraint chatwoot_messages_conversation_id_fkey;
      alter table public.chatwoot_conversations drop constraint chatwoot_conversations_contact_id_fkey;
      alter table public.chatwoot_contacts drop constraint chatwoot_contacts_pkey cascade;
      alter table public.chatwoot_conversations drop constraint chatwoot_conversations_pkey cascade;
      alter table public.chatwoot_messages drop constraint chatwoot_messages_pkey cascade;
      drop index public.uq_chatwoot_contacts_org_id;
      drop index public.uq_chatwoot_conversations_org_id;
      drop index public.uq_chatwoot_messages_org_id;
      alter table public.chatwoot_conversations disable trigger trg_sync_chatwoot_conversations_organizacao;
      alter table public.chatwoot_messages disable trigger trg_sync_chatwoot_messages_organizacao;
      discard plans;`);
    await admin.query('set local role service_role');
    const escopos = [[ORG_A, CONEXAO_A1], [ORG_A, CONEXAO_A2], [ORG_B, CONEXAO_B1]];
    const mensagens = [];
    for (const [org, conexao] of escopos) {
      const contato = (await admin.query(SQL_INSERIR_CONTATO, [500005, org, conexao, `contato ${conexao}`])).rows[0].id_local;
      const conversa = (await admin.query(
        `insert into public.chatwoot_conversations (id, id_externo, organizacao_id, conexao_id, contact_id, contato_id_local, status)
         values (500050, '500050', $1, $2, 500005, $3, 'open') returning id_local`, [org, conexao, contato])).rows[0].id_local;
      mensagens.push((await admin.query(
        `insert into public.chatwoot_messages (id, id_externo, organizacao_id, conexao_id, conversation_id, conversa_id_local, content)
         values (500500, '500500', $1, $2, 500050, $3, $4) returning id_local`, [org, conexao, conversa, `de ${conexao}`])).rows[0].id_local);
    }
    const resolvidos = [];
    for (const [org, conexao] of escopos) resolvidos.push(await resolver(admin, 'chatwoot_messages', org, conexao, 500500));
    const semFiltroDeConexao = (await admin.query(
      "select id_local from public.chatwoot_messages where organizacao_id = $1 and id_externo = '500500'", [ORG_A])).rows.length;
    const global = (await admin.query("select id_local from public.chatwoot_messages where id_externo = '500500'")).rows.length;
    const updateLegado = (await admin.query("update public.chatwoot_messages set content = 'sobrescrito' where id = 500500")).rowCount;

    const distintos = new Set(mensagens).size === 3
      && resolvidos.every((linhas, i) => linhas.length === 1 && linhas[0].id_local === mensagens[i]);
    if (!distintos || semFiltroDeConexao !== 2 || global !== 3 || updateLegado !== 3) {
      return err('ResolverChatwootPosContracaoFalhou', 'O resolver não separou as instalações ou a contraprova não reproduziu o defeito', {
        distintos, semFiltroDeConexao, global, updateLegado,
      });
    }
    return ok({ resumo: `pós-contração: 3 instalações, 3 UUIDs, 1 por escopo; contraprovas sem conexão=${semFiltroDeConexao}, `
      + `global=${global}, update por id=${updateLegado}` });
  } finally {
    await admin.query('ROLLBACK');
  }
}

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runResolverChatwootRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-resolver-chatwoot'),
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

    const resumos = [];
    for (const etapa of [() => corridas({ admin, clientA, clientB, timeoutDeObservacaoMs }), () => recusas(admin), () => posContracao(admin)]) {
      const resultado = await etapa();
      if (resultado._tag === 'err') return resultado;
      resumos.push(resultado.value.resumo);
    }

    return ok(Object.freeze({
      relato: `resolver do Chatwoot (MSG-003A) provado no Postgres: ${resumos.join('; ')}`,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('ResolverChatwootRehearsalFailed', 'Falha inesperada no rehearsal do resolver Chatwoot', {}, cause);
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
