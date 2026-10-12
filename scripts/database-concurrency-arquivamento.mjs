import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * PRE-003, migration 75. Prova contra Postgres real, com duas conexões e a
 * barreira determinística por `pg_stat_activity`, que:
 *
 * 1. dois arquivamentos simultâneos do MESMO produto se serializam na trava
 *    da linha: um arquiva, o outro vê `ja_arquivado` — sem segundo registro de
 *    quando nem quem, sem erro;
 * 2. a sincronização que regrava o produto (situação `ativo`, preço, estoque)
 *    enquanto o arquivamento segura a linha espera, e depois grava preço e
 *    estoque SEM desarquivar;
 * 3. nenhum dos dois mexe na reserva nem apaga itens de pedido.
 */

const ORG_ID = 'e7500000-0000-4000-8000-000000000001';
const OWNER_ID = 'e7500000-0000-4000-8000-000000000002';
const CLIENTE_ID = 'e7500000-0000-4000-8000-000000000003';
const PEDIDO_ID = 'e7500000-0000-4000-8000-000000000004';
const PRODUTO_A = 'e7510000-0000-4000-8000-000000000001';
const PRODUTO_B = 'e7510000-0000-4000-8000-000000000002';

async function semear(client) {
  await client.query("insert into auth.users (id, email) values ($1, 'owner-arquivamento@orbita.test')", [OWNER_ID]);
  await client.query(
    "insert into public.organizacoes (id, nome, slug, status) values ($1, 'Org Arquivamento', 'org-arquivamento', 'active')",
    [ORG_ID],
  );
  await client.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')", [ORG_ID, OWNER_ID]);
  await client.query(
    `insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, preco, estoque)
     values ($1, $3, $4, '75001', 'Produto A', 10, 10), ($2, $3, $4, '75002', 'Produto B', 20, 10)`,
    [PRODUTO_A, PRODUTO_B, ORG_ID, OWNER_ID],
  );
  await client.query(
    "insert into public.clientes (id, organizacao_id, user_id, bling_id, nome) values ($1, $2, $3, '75009', 'Cliente sintético')",
    [CLIENTE_ID, ORG_ID, OWNER_ID],
  );
  await client.query(
    `insert into public.pedidos (id, organizacao_id, user_id, bling_id, numero, data, cliente_id, total)
     values ($1, $2, $3, '75010', '75010', now(), $4, 30)`,
    [PEDIDO_ID, ORG_ID, OWNER_ID, CLIENTE_ID],
  );
  await client.query(
    `insert into public.itens_pedido (organizacao_id, user_id, pedido_id, produto_id, quantidade, valor_unitario)
     values ($1, $2, $3, $4, 2, 10), ($1, $2, $3, $5, 1, 20)`,
    [ORG_ID, OWNER_ID, PEDIDO_ID, PRODUTO_A, PRODUTO_B],
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
    return err('ArquivamentoRaceInicioFalhou', 'A primeira chamada falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('ArquivamentoRaceNaoBloqueou', 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  const b = await promiseB;
  if (!b.ok) return err('ArquivamentoRaceErroNaoTratado', 'A chamada perdedora lançou em vez de responder', { a, b });
  return ok({ a: a.linha, b: b.linha, waitEvent: observacao.waitEvent });
}

const SQL_ARQUIVAR = 'select * from public.arquivar_produto($1, $2, $3)';
/** O que a sincronização grava num produto que já existe: situação do Bling, preço e saldo. */
const SQL_SINCRONIZAR = `update public.produtos set situacao = 'ativo', preco = 99, estoque = 7
  where id = $1 and organizacao_id = $2 returning situacao, preco, estoque`;

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runArquivamentoRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-arquivamento'),
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
    const reservaAntes = (await admin.query('select estoque_reservado from public.produtos where id = $1', [PRODUTO_A])).rows[0].estoque_reservado;

    const dois = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_ARQUIVAR, paramsA: [ORG_ID, PRODUTO_A, OWNER_ID],
      sqlB: SQL_ARQUIVAR, paramsB: [ORG_ID, PRODUTO_A, OWNER_ID],
    });
    if (dois._tag === 'err') return dois;
    const a = (await admin.query(
      'select situacao, estoque_reservado, arquivado_em from public.produtos where id = $1', [PRODUTO_A])).rows[0];
    if (dois.value.a.desfecho !== 'arquivado' || dois.value.b.desfecho !== 'ja_arquivado'
        || String(dois.value.b.arquivado_em) !== String(a.arquivado_em) || a.situacao !== 'arquivado'
        || a.estoque_reservado !== reservaAntes) {
      return err('ArquivamentoRaceDuplo', 'Dois arquivamentos concorrentes não convergiram para um só', { a: dois.value.a, b: dois.value.b, produto: a });
    }

    const comSync = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_ARQUIVAR, paramsA: [ORG_ID, PRODUTO_B, OWNER_ID],
      sqlB: SQL_SINCRONIZAR, paramsB: [PRODUTO_B, ORG_ID],
    });
    if (comSync._tag === 'err') return comSync;
    const b = (await admin.query('select situacao, preco, estoque from public.produtos where id = $1', [PRODUTO_B])).rows[0];
    const itens = (await admin.query(
      'select count(*)::int as n from public.itens_pedido where pedido_id = $1 and produto_nome is not null', [PEDIDO_ID])).rows[0].n;
    if (comSync.value.a.desfecho !== 'arquivado' || b.situacao !== 'arquivado' || Number(b.preco) !== 99 || b.estoque !== 7 || itens !== 2) {
      return err('ArquivamentoRaceDesarquivou', 'A sincronização concorrente desfez o arquivamento ou perdeu itens', { produto: b, itens });
    }

    return ok(Object.freeze({
      relato: `arquivamento provado com bloqueio observado no Postgres: dois arquivamentos simultâneos (wait_event=${dois.value.waitEvent}) `
        + `deram arquivado e ja_arquivado, reserva intacta (${a.estoque_reservado}); a sincronização concorrente `
        + `(wait_event=${comSync.value.waitEvent}) gravou preço ${Number(b.preco)} e estoque ${b.estoque} e o produto continuou ${b.situacao}; `
        + `${itens} itens do pedido com o retrato do produto`,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('ArquivamentoRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência do arquivamento', {}, cause);
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
