import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { correr as correrBase, executar, fabricarLegado as fabricar, semEsperar as semEsperarBase } from './database-concurrency-chatwoot.mjs';

/**
 * MSG-003A, no schema contraído do MSG-004. Prova contra Postgres real, como
 * `service_role`, que as instruções do store de espelhos
 * (`src/services/chatwoot/espelhoChatwootSupabase.ts`) localizam e gravam pelo
 * UUID local sem misturar instalações:
 *
 * Os ids ficam na faixa 330000+ para não cruzar com os do ensaio do MSG-002.
 * Linhas legadas (sem conexão, anteriores ao MSG-004) são fabricadas com o
 * gatilho de identidade desligado: depois do MSG-004 nenhuma escrita as cria.
 *
 * 1. duas escritas da MESMA conexão criando o mesmo contato: a segunda espera e
 *    recebe 23505; relendo pelo resolver, encontra a linha da primeira e a
 *    atualiza — uma linha, um UUID (o caminho de retry do `gravar`);
 * 2. a organização B criando o mesmo contato enquanto A grava: B não espera
 *    (sem chave global) e grava o seu; cada escopo resolve só a sua linha;
 * 3. duas instalações da mesma organização adotando a mesma linha legada sem
 *    conexão, provada em A1 pelo inbox: A1 adota; A2 espera e, depois do
 *    commit, o filtro de conexão do `update` não casa mais — zero linhas;
 * 4. mensagem ligada à conversa de outra conexão é recusada (23503) e o
 *    `authenticated` não escreve nos espelhos (42501);
 * 5. PRE-008 × MSG-002: desligar a conexão e reativá-la pelo mesmo `update`
 *    da rota de connect, com o evento de auditoria pela RPC real, mantém o
 *    `conexao_id` e a associação de identidades: o resolver devolve os mesmos
 *    UUIDs e o vínculo conversa → contato continua o mesmo;
 * 6. o webhook de status não altera conversa sem conexão comprovada: legada em
 *    quarentena, duas conexões da mesma organização, conexão que não prova a
 *    posse, id remoto coincidente, repetição e concorrência;
 * 7. no schema contraído (transação desfeita no fim), três instalações com os
 *    mesmos ids 5/50/500 gravam espelhos distintos (a escrita do webhook), o
 *    replay do sync atualiza cada uma pelo seu UUID sem tocar as outras, e o
 *    resolver devolve exatamente um UUID por escopo.
 *    Contraprovas: sem o filtro de conexão a busca fica
 *    ambígua (2) e por id global encontra as três; um `update` legado por `id`
 *    tocaria as três.
 */

const ORG_A = 'e3300000-0000-4000-8000-00000000000a';
const ORG_B = 'e3300000-0000-4000-8000-00000000000b';
const CONEXAO_A1 = 'e3300000-0000-4000-8000-0000000000c1';
const CONEXAO_A2 = 'e3300000-0000-4000-8000-0000000000c2';
const CONEXAO_B1 = 'e3300000-0000-4000-8000-0000000000c3';
const OWNER_A = 'e3300000-0000-4000-8000-0000000000a1';

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
  await client.query("insert into auth.users (id, email) values ($1, 'owner-resolver@orbita.test')", [OWNER_A]);
  await client.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')", [ORG_A, OWNER_A]);
  // O inbox 330 só existe em A1: prova de conexão para a adoção legada (3).
  await client.query("insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id) values ($1, $2, 330, '1')",
    [ORG_A, CONEXAO_A1]);
}

const ROTULO = { rotulo: 'ResolverChatwootRace' };
const correr = (ctx) => correrBase({ ...ctx, ...ROTULO });
const semEsperar = (ctx) => semEsperarBase({ ...ctx, ...ROTULO });
const fabricarLegado = (client, linha) => fabricar(client, { organizacao: ORG_A, ...linha });

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

  const outraOrganizacao = await semEsperar({
    ...ctx,
    sqlA: SQL_INSERIR_CONTATO, paramsA: [330006, ORG_A, CONEXAO_A1, 'de A'],
    sqlB: SQL_INSERIR_CONTATO, paramsB: [330006, ORG_B, CONEXAO_B1, 'de B'],
  });
  if (outraOrganizacao._tag === 'err') return outraOrganizacao;
  const noEscopoDeA = await resolver(clientB, 'chatwoot_contacts', ORG_A, CONEXAO_A1, 330006);
  const noEscopoDeB = await resolver(clientB, 'chatwoot_contacts', ORG_B, CONEXAO_B1, 330006);
  const contato6 = (await admin.query(
    'select id_local, organizacao_id, name from public.chatwoot_contacts where id = 330006 order by name')).rows;
  if (!outraOrganizacao.value.b.ok || contato6.length !== 2
      || noEscopoDeA.length !== 1 || noEscopoDeA[0].id_local !== outraOrganizacao.value.a[0].id_local
      || noEscopoDeB.length !== 1 || noEscopoDeB[0].id_local !== outraOrganizacao.value.b.linhas[0].id_local
      || contato6[0].name !== 'de A' || contato6[0].organizacao_id !== ORG_A
      || contato6[1].name !== 'de B' || contato6[1].organizacao_id !== ORG_B) {
    return err('ResolverChatwootRaceMisturou', 'Os contatos 330006 de A e B não coexistiram cada um no seu escopo', {
      b: outraOrganizacao.value.b, noEscopoDeA, noEscopoDeB, contato6,
    });
  }

  // Legado do sync antigo, com a conversa no inbox 330 (só de A1): A1 tem a prova.
  const legado = await fabricarLegado(admin, { contato: 330021, conversa: 330210, inbox: 330 });
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
      + 'outra organização sem esperar → duas linhas, uma por escopo; '
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

/** `upsertChatwootConnection` da rota de connect: a reativação reaproveita a linha. */
const SQL_REATIVAR_CONEXAO = `update public.conexoes_integracao
  set status = 'pendente', last_health_check_at = null, last_health_error = null, updated_at = now()
  where id = $1 and organizacao_id = $2 returning id`;
/** `auditarConexao` → `recordAuditEvent` → a RPC da migration 36. */
const SQL_AUDITAR_REATIVACAO = `select public.registrar_evento_auditoria($1, $2, 'integration.connection_configured',
  'conexoes_integracao', $3::text, 'msg-003a-ciclo', null, null, '{"provedor":"chatwoot","status":"pendente"}'::jsonb) as evento`;

/** 5: desligar e reativar a conexão não desfaz a associação de identidades. */
async function cicloDaConexao(admin) {
  await admin.query("insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name) values (330040, $1, $2, 'antes do ciclo')", [ORG_A, CONEXAO_A1]);
  await admin.query("insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status) values (330041, $1, $2, 330040, 'open')", [ORG_A, CONEXAO_A1]);
  const antes = {
    contato: (await resolver(admin, 'chatwoot_contacts', ORG_A, CONEXAO_A1, 330040))[0].id_local,
    conversa: (await resolver(admin, 'chatwoot_conversations', ORG_A, CONEXAO_A1, 330041))[0].id_local,
  };
  // Como o `supabaseServer`: papel `service_role` e o claim que a RPC de auditoria confere.
  await admin.query('set role service_role');
  await admin.query("select set_config('request.jwt.claim.role', 'service_role', false)");
  try {
    await admin.query("update public.conexoes_integracao set status = 'desconectado' where id = $1", [CONEXAO_A1]);
    const reativada = await admin.query(SQL_REATIVAR_CONEXAO, [CONEXAO_A1, ORG_A]);
    const evento = await admin.query(SQL_AUDITAR_REATIVACAO, [ORG_A, OWNER_A, CONEXAO_A1]);
    const depois = {
      contato: await resolver(admin, 'chatwoot_contacts', ORG_A, CONEXAO_A1, 330040),
      conversa: await resolver(admin, 'chatwoot_conversations', ORG_A, CONEXAO_A1, 330041),
    };
    const vinculo = (await admin.query(
      'select contato_id_local, conexao_id from public.chatwoot_conversations where id_local = $1', [antes.conversa])).rows[0];
    const auditado = (await admin.query(
      "select count(*)::int as n from public.eventos_auditoria_sistema where organizacao_id = $1 and acao = 'integration.connection_configured' and recurso_id = $2",
      [ORG_A, CONEXAO_A1])).rows[0].n;
    if (reativada.rows[0]?.id !== CONEXAO_A1 || !evento.rows[0]?.evento || auditado !== 1
        || depois.contato.length !== 1 || depois.contato[0].id_local !== antes.contato
        || depois.conversa.length !== 1 || depois.conversa[0].id_local !== antes.conversa
        || vinculo.contato_id_local !== antes.contato || vinculo.conexao_id !== CONEXAO_A1) {
      return err('ResolverChatwootCicloPerdeuIdentidade', 'A reativação auditada mudou a conexão ou a associação de identidades', {
        reativada: reativada.rows, auditado, depois, vinculo,
      });
    }
    return ok({ resumo: `desligar → reativar auditado (${auditado} evento) mantém conexão, UUIDs e vínculo conversa → contato` });
  } finally {
    await admin.query("select set_config('request.jwt.claim.role', '', false)");
    await admin.query('reset role');
  }
}

/**
 * O `update` de status do store (`atualizar` com `somenteConexaoProvada`):
 * pelo UUID local, na organização, e só na conexão do escopo.
 */
const SQL_STATUS = `update public.chatwoot_conversations set status = $4, updated_at = now()
  where organizacao_id = $1 and id_local = $2 and conexao_id = $3 returning id_local`;
/** CONTRAPROVA: o filtro de antes da correção, que aceitava linha sem conexão. */
const SQL_STATUS_SEM_PROVA = `update public.chatwoot_conversations set status = $4, updated_at = now()
  where organizacao_id = $1 and id_local = $2 and (conexao_id = $3 or conexao_id is null) returning id_local`;

/**
 * `atualizarStatusDaConversa` (espelhoChatwoot.ts) com as instruções do store:
 * resolve o id remoto no escopo; candidato legado (sem conexão) não é tocado;
 * com a conexão comprovada, atualiza pelo UUID local. Devolve quantas linhas mudaram.
 */
async function statusPeloFluxo(client, organizacao, conexao, idExterno, status) {
  const candidatos = await resolver(client, 'chatwoot_conversations', organizacao, conexao, idExterno);
  if (candidatos.length !== 1 || candidatos[0].conexao_id === null) return 0;
  return (await client.query(SQL_STATUS, [organizacao, candidatos[0].id_local, conexao, status])).rowCount;
}

const conversaPorId = async (client, id) => (await client.query(
  'select id_local, conexao_id, status from public.chatwoot_conversations where id = $1', [id])).rows[0];

/**
 * 6: o webhook de status não altera conversa cuja ligação com a conexão de
 * origem não está comprovada (revisão independente do MSG-003A).
 */
async function statusSemProva(ctx) {
  const { admin, clientA, clientB } = ctx;
  // a/b. Conversas legadas da organização A, sem conexão provada (sem inbox mapeado).
  await fabricarLegado(admin, { contato: 330061, conversa: 330060, inbox: 999 });
  await fabricarLegado(admin, { contato: 330063, conversa: 330062, inbox: 998 });
  // d. A conversa 330064 é provada na segunda instalação de A.
  await admin.query("insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name) values (330065, $1, $2, 'de A2')", [ORG_A, CONEXAO_A2]);
  await admin.query("insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, status) values (330064, $1, $2, 330065, 'open')", [ORG_A, CONEXAO_A2]);
  const quarentena = (await admin.query(
    "select count(*)::int as n from public.chatwoot_identidade_em_quarentena where tabela = 'chatwoot_conversations' and id_externo in ('330060', '330062')")).rows[0].n;

  const falhas = [];
  // a/c. Webhook de A1 na conversa legada: A1 não prova ser dona dela.
  const legadaA1 = await statusPeloFluxo(clientA, ORG_A, CONEXAO_A1, 330060, 'resolved');
  if (legadaA1 !== 0) falhas.push(`a: webhook de A1 alterou ${legadaA1} conversa legada sem conexão provada`);
  // b/c. As duas conexões da organização tentam a outra legada; nenhuma prova a posse.
  for (const conexao of [CONEXAO_A1, CONEXAO_A2]) {
    const n = await statusPeloFluxo(clientA, ORG_A, conexao, 330062, 'pending');
    if (n !== 0) falhas.push(`b: a conexão ${conexao.slice(-2)} alterou a conversa legada 330062`);
  }
  // d. Id remoto da conversa de A2 vindo de A1 e de B: nada muda; de A2, muda (controle positivo).
  const deA1 = await statusPeloFluxo(clientA, ORG_A, CONEXAO_A1, 330064, 'resolved');
  const deB = await statusPeloFluxo(clientA, ORG_B, CONEXAO_B1, 330064, 'resolved');
  if (deA1 !== 0 || deB !== 0) falhas.push(`d: A1 (${deA1}) ou B (${deB}) alterou a conversa provada em A2`);
  const deA2 = await statusPeloFluxo(clientA, ORG_A, CONEXAO_A2, 330064, 'resolved');
  // e. Repetição: o mesmo status de novo é idempotente, uma linha.
  const repetido = await statusPeloFluxo(clientA, ORG_A, CONEXAO_A2, 330064, 'resolved');
  if (deA2 !== 1 || repetido !== 1) falhas.push(`d/e: a dona (A2) não aplicou o status (${deA2}, ${repetido})`);

  // e. Concorrência na conversa legada: A1 e A2 ao mesmo tempo; nenhuma altera.
  const legada = await conversaPorId(admin, 330060);
  const [concA1, concA2] = await Promise.all([
    statusPeloFluxo(clientA, ORG_A, CONEXAO_A1, 330060, 'pending'),
    statusPeloFluxo(clientB, ORG_A, CONEXAO_A2, 330060, 'resolved'),
  ]);
  if (concA1 !== 0 || concA2 !== 0) falhas.push(`e: escritas concorrentes alteraram a conversa legada (${concA1}, ${concA2})`);
  // e. Concorrência na conversa da dona: as duas entregas de A2 se serializam, uma linha.
  const dona = await correr({
    ...ctx,
    sqlA: SQL_STATUS, paramsA: [ORG_A, (await conversaPorId(admin, 330064)).id_local, CONEXAO_A2, 'pending'],
    sqlB: SQL_STATUS, paramsB: [ORG_A, (await conversaPorId(admin, 330064)).id_local, CONEXAO_A2, 'open'],
  });
  if (dona._tag === 'err') return dona;

  const finais = {
    c330060: await conversaPorId(admin, 330060),
    c330062: await conversaPorId(admin, 330062),
    c330064: await conversaPorId(admin, 330064),
  };
  if (finais.c330060.status !== 'open' || finais.c330060.conexao_id !== null || finais.c330060.id_local !== legada.id_local) {
    falhas.push(`a/e: a conversa legada 330060 terminou ${finais.c330060.status}/${finais.c330060.conexao_id}`);
  }
  if (finais.c330062.status !== 'open' || finais.c330062.conexao_id !== null) falhas.push(`b: a conversa legada 330062 terminou ${finais.c330062.status}`);
  if (!dona.value.b.ok || finais.c330064.status !== 'open' || finais.c330064.conexao_id !== CONEXAO_A2) {
    falhas.push(`e: a corrida da dona terminou ${finais.c330064.status}`);
  }
  if (quarentena !== 2) falhas.push(`pré-condição: ${quarentena} conversa(s) legada(s) na quarentena, esperado 2`);

  // O mecanismo, sem a guarda do fluxo: o `update` estrito não alcança a linha
  // legada. O filtro antigo a alcança (contraprova pelo predicado); desde o
  // MSG-004 o banco também recusa o conteúdo numa organização com duas
  // instalações (23514), em vez de aplicá-lo.
  await clientA.query('BEGIN');
  const estrito = (await clientA.query(SQL_STATUS, [ORG_A, legada.id_local, CONEXAO_A1, 'resolved'])).rowCount;
  const alcancada = (await clientA.query(
    'select count(*)::int as n from public.chatwoot_conversations where organizacao_id = $1 and id_local = $2 and (conexao_id = $3 or conexao_id is null)',
    [ORG_A, legada.id_local, CONEXAO_A1])).rows[0].n;
  const semProva = await executar(clientA, SQL_STATUS_SEM_PROVA, [ORG_A, legada.id_local, CONEXAO_A1, 'resolved']);
  await clientA.query('ROLLBACK');
  if (estrito !== 0 || alcancada !== 1 || semProva.ok || semProva.code !== '23514') {
    falhas.push(`mecanismo: update estrito=${estrito} (esperado 0), filtro antigo alcança=${alcancada} (esperado 1), banco=${semProva.code} (esperado 23514)`);
  }
  if (falhas.length > 0) {
    return err('ResolverChatwootStatusSemProva', 'O webhook de status alterou conversa sem conexão comprovada', { falhas, finais });
  }
  return ok({ resumo: `status sem prova de conexão: legada intocada por A1, A2 e corrida (quarentena=${quarentena}), `
    + `id de A2 vindo de A1/B ignorado, dona aplica e repete, corrida da dona (wait_event=${dona.value.waitEvent}) serializada; `
    + 'update estrito na legada=0; o filtro antigo alcança a legada (1) e o banco recusa (23514)' });
}

/** 7: o schema contraído, com três instalações; desfeito por rollback. */
async function posContracao(admin) {
  await admin.query('BEGIN');
  try {
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
    // O replay do sync em cada instalação: resolve no seu escopo e atualiza pelo UUID.
    for (const [org, conexao] of escopos) {
      const [linha] = await resolver(admin, 'chatwoot_messages', org, conexao, 500500);
      await admin.query(
        `update public.chatwoot_messages set content = $4
          where organizacao_id = $1 and id_local = $2 and (conexao_id = $3 or conexao_id is null)`,
        [org, linha.id_local, conexao, `sync de ${conexao}`]);
    }
    const conteudos = (await admin.query(
      "select id_local, conexao_id, content from public.chatwoot_messages where id_externo = '500500'")).rows;
    const syncIsolado = conteudos.length === 3 && conteudos.every((l) => l.content === `sync de ${l.conexao_id}`);
    const resolvidos = [];
    for (const [org, conexao] of escopos) resolvidos.push(await resolver(admin, 'chatwoot_messages', org, conexao, 500500));
    const semFiltroDeConexao = (await admin.query(
      "select id_local from public.chatwoot_messages where organizacao_id = $1 and id_externo = '500500'", [ORG_A])).rows.length;
    const global = (await admin.query("select id_local from public.chatwoot_messages where id_externo = '500500'")).rows.length;
    const updateLegado = (await admin.query("update public.chatwoot_messages set content = 'sobrescrito' where id = 500500")).rowCount;

    const distintos = new Set(mensagens).size === 3
      && resolvidos.every((linhas, i) => linhas.length === 1 && linhas[0].id_local === mensagens[i]);
    if (!distintos || !syncIsolado || semFiltroDeConexao !== 2 || global !== 3 || updateLegado !== 3) {
      return err('ResolverChatwootPosContracaoFalhou', 'O resolver não separou as instalações ou a contraprova não reproduziu o defeito', {
        distintos, syncIsolado, semFiltroDeConexao, global, updateLegado,
      });
    }
    return ok({ resumo: 'schema contraído: 3 instalações, 3 UUIDs, 1 por escopo, replay do sync isolado; '
      + `contraprovas sem conexão=${semFiltroDeConexao}, `
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
    for (const etapa of [() => corridas({ admin, clientA, clientB, timeoutDeObservacaoMs }), () => recusas(admin), () => cicloDaConexao(admin), () => statusSemProva({ admin, clientA, clientB, timeoutDeObservacaoMs }), () => posContracao(admin)]) {
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
