import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

/**
 * Corrida da foto do produto: duas abas trocando a MESMA foto ao mesmo tempo.
 *
 * ## O que o pgTAP não alcança
 *
 * `supabase/tests/database/foto_personalizada_do_produto.test.sql` prova, numa
 * transação só, que um compare-and-set com precondição desatualizada não troca
 * nada. O que ele não pode exercitar é a corrida: as duas transações leem a
 * MESMA foto `A` como atual, e só a trava da linha decide quem vence.
 *
 * Sob READ COMMITTED, T2 bloqueia na linha que T1 alterou e, quando T1
 * commita, reavalia o `WHERE imagem_storage_path = A` contra a versão nova —
 * que já é `B`. Zero linhas: T2 perde sem sobrescrever.
 *
 * Invariante provado aqui, nas duas partidas (troca × troca e remoção × troca):
 * **exatamente uma transação muda a foto, e a outra vê zero linhas.**
 */

const ORG_ID = 'c7000000-0000-4000-8000-000000000001';
const OWNER_ID = 'c7000000-0000-4000-8000-000000000002';
const PRODUTO_ID = 'c7000000-0000-4000-8000-00000000000a';
const prefixo = `${ORG_ID}/${PRODUTO_ID}`;
const FOTO_A = `${prefixo}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const FOTO_B = `${prefixo}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;
const FOTO_C = `${prefixo}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`;

/**
 * O `UPDATE` que `ProdutoImagemRepository.trocarCaminho` emite pelo PostgREST:
 * apontar para uma foto adota a imagem (`imagem_bling_gerenciada_pelo_orbita`)
 * na mesma instrução; remover não a devolve.
 */
const CAS = `
  update public.produtos
     set imagem_storage_path = $1::text,
         imagem_bling_gerenciada_pelo_orbita = imagem_bling_gerenciada_pelo_orbita or $1::text is not null
   where id = $2
     and organizacao_id = $3
     and imagem_storage_path = $4
  returning id
`;

async function semear(client, fotoInicial = FOTO_A) {
  await client.query('delete from public.produtos where id = $1', [PRODUTO_ID]);
  await client.query('delete from public.membros_organizacao where organizacao_id = $1', [ORG_ID]);
  await client.query('delete from public.organizacoes where id = $1', [ORG_ID]);
  await client.query('delete from auth.users where id = $1', [OWNER_ID]);

  await client.query("insert into auth.users (id, email) values ($1, 'owner-foto@orbita.test')", [OWNER_ID]);
  await client.query(
    "insert into public.organizacoes (id, nome, slug, status) values ($1, 'Org Foto', 'org-foto', 'active')",
    [ORG_ID],
  );
  await client.query(
    "insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')",
    [ORG_ID, OWNER_ID],
  );
  await client.query(
    `insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, imagem_url, imagem_storage_path, imagem_bling_gerenciada_pelo_orbita)
     values ($1, $2, $3, '71001', 'Produto Foto', 'https://bling/foto.jpg', $4::text, $4::text is not null)`,
    [PRODUTO_ID, ORG_ID, OWNER_ID, fotoInicial],
  );
}

async function fotoAtual(client) {
  const { rows } = await client.query('select imagem_storage_path from public.produtos where id = $1', [PRODUTO_ID]);
  return rows[0]?.imagem_storage_path ?? null;
}

/** A autoridade da imagem: depois de uma foto, nunca volta a false. */
async function gerenciada(client) {
  const { rows } = await client.query('select imagem_bling_gerenciada_pelo_orbita as g from public.produtos where id = $1', [PRODUTO_ID]);
  return rows[0]?.g ?? null;
}

/**
 * A exclusão da deduplicação (`ProdutoRepository.excluirDuplicadoSemFoto`):
 * a decisão "sem foto" é parte do próprio `DELETE`.
 */
const DELETE_SEM_FOTO = `
  delete from public.produtos
   where id = $1
     and organizacao_id = $2
     and imagem_storage_path is null
  returning id
`;

/** T2 está parada esperando a trava de T1? Evidência de que a corrida aconteceu de fato. */
async function esperandoTrava(base, pid) {
  const { rows } = await base.query('select wait_event_type from pg_stat_activity where pid = $1', [pid]);
  return rows[0]?.wait_event_type ?? null;
}

/**
 * T1 aplica o CAS e segura a transação aberta; T2 dispara o dela partindo do
 * mesmo `A` e fica presa na trava; T1 commita; T2 termina.
 */
async function encenar({ criarCliente, novoDeT1, novoDeT2, sobreposicaoMs }) {
  const base = criarCliente();
  await base.connect();
  await semear(base);

  const t1 = criarCliente();
  const t2 = criarCliente();
  await t1.connect();
  await t2.connect();
  try {
    const { rows: [{ pid }] } = await t2.query('select pg_backend_pid() as pid');
    await t1.query('begin');
    await t2.query('begin');

    const linhasT1 = (await t1.query(CAS, [novoDeT1, PRODUTO_ID, ORG_ID, FOTO_A])).rowCount;
    const t2EmVoo = t2.query(CAS, [novoDeT2, PRODUTO_ID, ORG_ID, FOTO_A]);

    await new Promise((resolve) => setTimeout(resolve, sobreposicaoMs));
    const bloqueio = await esperandoTrava(base, pid);
    await t1.query('commit');
    const linhasT2 = (await t2EmVoo).rowCount;
    await t2.query('commit');

    return { linhasT1, linhasT2, bloqueio, final: await fotoAtual(base), gerenciada: await gerenciada(base) };
  } finally {
    await t1.end().catch(() => {});
    await t2.end().catch(() => {});
    await base.end().catch(() => {});
  }
}

/**
 * Corrida da deduplicação: T1 confirma uma foto num produto que estava sem foto
 * (CAS null → A) e segura a transação; T2 roda o DELETE condicionado da
 * deduplicação sobre a mesma linha, fica presa na trava e, quando T1 commita,
 * reavalia `imagem_storage_path is null` contra a versão nova. Zero linhas: a
 * linha e a foto ficam.
 */
async function encenarDeduplicacao({ criarCliente, sobreposicaoMs }) {
  const base = criarCliente();
  await base.connect();
  await semear(base, null);

  const t1 = criarCliente();
  const t2 = criarCliente();
  await t1.connect();
  await t2.connect();
  try {
    const { rows: [{ pid }] } = await t2.query('select pg_backend_pid() as pid');
    await t1.query('begin');
    await t2.query('begin');

    const linhasT1 = (await t1.query(
      `update public.produtos set imagem_storage_path = $1, imagem_bling_gerenciada_pelo_orbita = true
        where id = $2 and organizacao_id = $3 and imagem_storage_path is null returning id`,
      [FOTO_A, PRODUTO_ID, ORG_ID],
    )).rowCount;
    const t2EmVoo = t2.query(DELETE_SEM_FOTO, [PRODUTO_ID, ORG_ID]);

    await new Promise((resolve) => setTimeout(resolve, sobreposicaoMs));
    const bloqueio = await esperandoTrava(base, pid);
    await t1.query('commit');
    const excluidasT2 = (await t2EmVoo).rowCount;
    await t2.query('commit');

    const { rows } = await base.query('select count(*)::int as n from public.produtos where id = $1', [PRODUTO_ID]);
    return { linhasT1, excluidasT2, bloqueio, linhaExiste: rows[0].n === 1, final: await fotoAtual(base), gerenciada: await gerenciada(base) };
  } finally {
    await t1.end().catch(() => {});
    await t2.end().catch(() => {});
    await base.end().catch(() => {});
  }
}

const ADQUIRIR_LEASE = 'select public.adquirir_lease_da_foto_no_bling($1, $2, $3, 90) as adquiriu';
const TOKEN_1 = 'c7000000-0000-4000-8000-0000000000e1';
const TOKEN_2 = 'c7000000-0000-4000-8000-0000000000e2';

/**
 * Corrida do lease da sincronização com o Bling (migration 72): T1 adquire e
 * segura a transação; T2 tenta adquirir o MESMO produto, fica presa na trava
 * da linha e, quando T1 commita, reavalia "lease ausente ou expirado" contra a
 * versão nova — que já tem o lease vigente de T1. Só uma adquire.
 */
async function encenarLease({ criarCliente, sobreposicaoMs }) {
  const base = criarCliente();
  await base.connect();
  await semear(base);

  const t1 = criarCliente();
  const t2 = criarCliente();
  await t1.connect();
  await t2.connect();
  try {
    const { rows: [{ pid }] } = await t2.query('select pg_backend_pid() as pid');
    await t1.query('begin');
    await t2.query('begin');

    const adquiriuT1 = (await t1.query(ADQUIRIR_LEASE, [ORG_ID, PRODUTO_ID, TOKEN_1])).rows[0].adquiriu;
    const t2EmVoo = t2.query(ADQUIRIR_LEASE, [ORG_ID, PRODUTO_ID, TOKEN_2]);

    await new Promise((resolve) => setTimeout(resolve, sobreposicaoMs));
    const bloqueio = await esperandoTrava(base, pid);
    await t1.query('commit');
    const adquiriuT2 = (await t2EmVoo).rows[0].adquiriu;
    await t2.query('commit');

    const { rows } = await base.query('select imagem_bling_sync_lease_token::text as dono from public.produtos where id = $1', [PRODUTO_ID]);
    return { adquiriuT1, adquiriuT2, bloqueio, dono: rows[0]?.dono ?? null };
  } finally {
    await t1.end().catch(() => {});
    await t2.end().catch(() => {});
    await base.end().catch(() => {});
  }
}

function violacoesDoLease(r) {
  const problemas = [];
  if (r.adquiriuT1 !== true) problemas.push('lease: T1 não adquiriu um produto sem lease');
  if (r.adquiriuT2 !== false) problemas.push('lease: T2 também adquiriu — duas execuções escreveriam no Bling');
  if (r.dono !== TOKEN_1) problemas.push('lease: o dono final não é T1');
  if (r.bloqueio !== 'Lock') problemas.push(`lease: T2 não esperou a trava (wait_event_type=${r.bloqueio})`);
  return problemas;
}

function violacoesDaDeduplicacao(r) {
  const problemas = [];
  if (r.linhasT1 !== 1) problemas.push(`deduplicação: a confirmação trocou ${r.linhasT1} linhas, esperado 1`);
  if (r.excluidasT2 !== 0) problemas.push(`deduplicação: o DELETE condicionado excluiu ${r.excluidasT2} linhas, esperado 0 (foto órfã)`);
  if (!r.linhaExiste) problemas.push('deduplicação: a linha com foto sumiu');
  if (r.final !== FOTO_A) problemas.push(`deduplicação: foto final ${r.final}, esperado ${FOTO_A}`);
  if (r.bloqueio !== 'Lock') problemas.push(`deduplicação: o DELETE não esperou a trava (wait_event_type=${r.bloqueio})`);
  if (r.gerenciada !== true) problemas.push('deduplicação: a confirmação vencedora não adotou a imagem');
  return problemas;
}

function violacoes(nome, resultado, esperadoFinal) {
  const problemas = [];
  if (resultado.linhasT1 !== 1) problemas.push(`${nome}: T1 trocou ${resultado.linhasT1} linhas, esperado 1`);
  if (resultado.linhasT2 !== 0) problemas.push(`${nome}: T2 trocou ${resultado.linhasT2} linhas, esperado 0 (sobrescrita silenciosa)`);
  if (resultado.final !== esperadoFinal) problemas.push(`${nome}: foto final ${resultado.final}, esperado ${esperadoFinal}`);
  if (resultado.bloqueio !== 'Lock') problemas.push(`${nome}: T2 não esperou a trava (wait_event_type=${resultado.bloqueio})`);
  if (resultado.gerenciada !== true) problemas.push(`${nome}: a autoridade da imagem não ficou com o ORBITA (${resultado.gerenciada})`);
  return problemas;
}

/**
 * @param {object} options
 * @param {() => import('pg').Client} [options.createClient] - Fábrica de cliente do laboratório.
 * @param {number} [options.sobreposicaoMs] - Janela em que T1 fica aberta com T2 já disparada.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: { readonly relato: string } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>}
 */
export async function runFotoDoProdutoRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-foto'),
  sobreposicaoMs = 800,
} = {}) {
  try {
    const trocaTroca = await encenar({ criarCliente: createClient, novoDeT1: FOTO_B, novoDeT2: FOTO_C, sobreposicaoMs });
    const remocaoTroca = await encenar({ criarCliente: createClient, novoDeT1: null, novoDeT2: FOTO_C, sobreposicaoMs });
    const deduplicacao = await encenarDeduplicacao({ criarCliente: createClient, sobreposicaoMs });
    const lease = await encenarLease({ criarCliente: createClient, sobreposicaoMs });

    const problemas = [
      ...violacoes('troca × troca', trocaTroca, FOTO_B),
      ...violacoes('remoção × troca', remocaoTroca, null),
      ...violacoesDaDeduplicacao(deduplicacao),
      ...violacoesDoLease(lease),
    ];
    if (problemas.length > 0) {
      return err('FotoDoProdutoRaceViolated', `corrida da foto violou o invariante: ${problemas.join(' | ')}`, { problemas });
    }

    return ok(Object.freeze({
      relato:
        'compare-and-set da foto provado nas DUAS partidas com bloqueio observado no Postgres '
        + `(wait_event_type=${trocaTroca.bloqueio}): troca × troca deixa a foto da vencedora e a perdedora `
        + `vê ${trocaTroca.linhasT2} linhas; remoção × troca deixa o produto sem foto e a troca atrasada `
        + `vê ${remocaoTroca.linhasT2} linhas — nenhuma sobrescrita silenciosa; confirmação × DELETE condicionado da deduplicação: `
        + `o DELETE espera a trava e exclui ${deduplicacao.excluidasT2} linhas, a linha e a foto ficam; `
        + `lease da sincronização com o Bling × lease: a segunda aquisição espera a trava `
        + `(wait_event_type=${lease.bloqueio}) e não adquire (${lease.adquiriuT2}) — uma execução por produto`,
    }));
  } catch (cause) {
    return err('FotoDoProdutoRaceFailed', 'não foi possível encenar a corrida da foto do produto', {}, cause);
  }
}
