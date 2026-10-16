import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * PRE-006C, migration 80. Prova contra Postgres real, com duas conexões e a
 * barreira determinística por `pg_stat_activity`:
 *
 * 1. dois atendentes sincronizando o SAC ao mesmo tempo com o mesmo telefone:
 *    `registrar_cliente_do_sac` de B espera a trava consultiva de A e, depois
 *    do commit, responde `ja_existia` — um cliente só;
 * 2. a baixa da venda manual (`baixar_estoque_organizacao`) segura a linha do
 *    produto; o alinhamento ao saldo do Bling, feito com o estoque lido ANTES
 *    da baixa, espera e, depois do commit, responde `divergiu` sem escrever —
 *    a baixa não é desfeita e o livro só tem o lançamento dela;
 * 3. dois alinhamentos idênticos (retry concorrente): um `alinhado`, o outro
 *    `ja_alinhado`, e um único lançamento no livro.
 */

const ORG_ID = 'e8000000-0000-4000-8000-000000000001';
const ATENDENTE_A = 'e8000000-0000-4000-8000-000000000002';
const ATENDENTE_B = 'e8000000-0000-4000-8000-000000000003';
const PRODUTO_ID = 'e8000000-0000-4000-8000-00000000000a';
const TELEFONE = '+5548999990080';

async function semear(client) {
  await client.query(
    "insert into auth.users (id, email) values ($1, 'a-pre006c@orbita.test'), ($2, 'b-pre006c@orbita.test')",
    [ATENDENTE_A, ATENDENTE_B],
  );
  await client.query(
    "insert into public.organizacoes (id, nome, slug, status) values ($1, 'Org PRE-006C', 'org-pre006c', 'active')",
    [ORG_ID],
  );
  await client.query(
    "insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner'), ($1, $3, 'member')",
    [ORG_ID, ATENDENTE_A, ATENDENTE_B],
  );
  await client.query(
    `insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, estoque, estoque_reservado)
     values ($1, $2, $3, '80001', 'Produto PRE-006C', 5, 0)`,
    [PRODUTO_ID, ORG_ID, ATENDENTE_A],
  );
}

async function executar(client, sql, params) {
  try {
    return { ok: true, linha: (await client.query(sql, params)).rows[0] };
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
    return err('ComandosComerciaisInicioFalhou', 'A primeira chamada falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('ComandosComerciaisNaoBloqueou', 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linha, b: await promiseB, waitEvent: observacao.waitEvent });
}

const SQL_SAC = 'select * from public.registrar_cliente_do_sac($1, $2, $3, null, $4, $4)';
const SQL_BAIXA = 'select * from public.baixar_estoque_organizacao($1, $2, 1, $3)';
const SQL_ALINHAR = 'select * from public.alinhar_estoque_ao_saldo_do_bling($1, $2, $3, $4, $5)';

async function livro(admin, origem) {
  return Number((await admin.query(
    'select count(*)::int as n from public.movimentacao_estoque where produto_id = $1 and origem = $2', [PRODUTO_ID, origem],
  )).rows[0].n);
}

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: { readonly relato: string } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runComandosComerciaisRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-comandos-comerciais'),
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

    const sac = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_SAC, paramsA: [ORG_ID, ATENDENTE_A, 'Contato A', TELEFONE],
      sqlB: SQL_SAC, paramsB: [ORG_ID, ATENDENTE_B, 'Contato B', TELEFONE],
    });
    if (sac._tag === 'err') return sac;
    const clientes = Number((await admin.query(
      'select count(*)::int as n from public.clientes where organizacao_id = $1 and telefone_normalizado = $2', [ORG_ID, TELEFONE],
    )).rows[0].n);
    if (sac.value.a.desfecho !== 'criado' || sac.value.b.linha?.desfecho !== 'ja_existia' || clientes !== 1) {
      return err('SacDuplicou', 'Duas sincronizações simultâneas não convergiram para um cliente', { a: sac.value.a, b: sac.value.b, clientes });
    }

    // Estoque 5 lido pela mudança de situação; a venda manual baixa 1 no meio.
    const baixa = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_BAIXA, paramsA: [ORG_ID, PRODUTO_ID, ATENDENTE_A],
      sqlB: SQL_ALINHAR, paramsB: [ORG_ID, ATENDENTE_A, PRODUTO_ID, 5, 7],
    });
    if (baixa._tag === 'err') return baixa;
    const aposBaixa = Number((await admin.query('select estoque from public.produtos where id = $1', [PRODUTO_ID])).rows[0].estoque);
    const alinhamentosAposBaixa = await livro(admin, 'ALINHAMENTO_SITUACAO_BLING');
    if (baixa.value.b.linha?.desfecho !== 'divergiu' || aposBaixa !== 4 || alinhamentosAposBaixa !== 0) {
      return err('AlinhamentoDesfezBaixa', 'O alinhamento com leitura velha sobrescreveu a baixa', { b: baixa.value.b, aposBaixa, alinhamentosAposBaixa });
    }

    const retry = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_ALINHAR, paramsA: [ORG_ID, ATENDENTE_A, PRODUTO_ID, 4, 6],
      sqlB: SQL_ALINHAR, paramsB: [ORG_ID, ATENDENTE_A, PRODUTO_ID, 4, 6],
    });
    if (retry._tag === 'err') return retry;
    const final = Number((await admin.query('select estoque from public.produtos where id = $1', [PRODUTO_ID])).rows[0].estoque);
    const alinhamentos = await livro(admin, 'ALINHAMENTO_SITUACAO_BLING');
    if (retry.value.a.desfecho !== 'alinhado' || retry.value.b.linha?.desfecho !== 'ja_alinhado' || final !== 6 || alinhamentos !== 1) {
      return err('AlinhamentoDuplicou', 'O retry concorrente lançou o alinhamento duas vezes', { a: retry.value.a, b: retry.value.b, final, alinhamentos });
    }

    return ok(Object.freeze({
      relato:
        'comandos de clientes e pedidos provados com bloqueio observado no Postgres: dois registros do SAC com o mesmo telefone '
        + `(wait_event=${sac.value.waitEvent}) deram criado e ja_existia com ${clientes} cliente; baixa da venda manual → alinhamento `
        + `com leitura velha (wait_event=${baixa.value.waitEvent}) deu divergiu, estoque ${aposBaixa} e nenhum lançamento de alinhamento; `
        + `dois alinhamentos idênticos (wait_event=${retry.value.waitEvent}) deram alinhado e ja_alinhado, estoque ${final}, `
        + `${alinhamentos} lançamento no livro`,
    }));
  } catch (cause) {
    return err('ComandosComerciaisRaceFailed', 'não foi possível encenar as corridas dos comandos comerciais', {}, cause);
  } finally {
    await clientA.end().catch(() => {});
    await clientB.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}
