import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * PRE-004, migration 76. Prova contra Postgres real, com duas conexões e a
 * barreira determinística por `pg_stat_activity`, que a tombstone de produto
 * excluído no Bling e a gravação do produto se serializam na mesma trava
 * consultiva de (organização, `bling_id`), nas DUAS ordens:
 *
 * 1. a exclusão segura a trava; o upsert do espelho (update atrasado) espera e,
 *    depois do commit, é recusado com 23514 — o produto fica arquivado, com
 *    nome, preço e itens de pedido intactos;
 * 2. a gravação de um produto novo segura a trava; a exclusão espera e, depois
 *    do commit, encontra o produto e o arquiva (`registrado`);
 * 3. duas exclusões simultâneas do mesmo id deixam uma tombstone só:
 *    `registrado` e `ja_registrado`.
 */

const ORG_ID = 'e7600000-0000-4000-8000-000000000001';
const OWNER_ID = 'e7600000-0000-4000-8000-000000000002';
const CLIENTE_ID = 'e7600000-0000-4000-8000-000000000003';
const PEDIDO_ID = 'e7600000-0000-4000-8000-000000000004';
const PRODUTO_A = 'e7610000-0000-4000-8000-000000000001';

async function semear(client) {
  await client.query("insert into auth.users (id, email) values ($1, 'owner-tombstone@orbita.test')", [OWNER_ID]);
  await client.query(
    "insert into public.organizacoes (id, nome, slug, status) values ($1, 'Org Tombstone', 'org-tombstone', 'active')",
    [ORG_ID],
  );
  await client.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')", [ORG_ID, OWNER_ID]);
  await client.query(
    `insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, preco, estoque)
     values ($1, $2, $3, '76001', 'Produto A', 10, 10)`,
    [PRODUTO_A, ORG_ID, OWNER_ID],
  );
  await client.query(
    "insert into public.clientes (id, organizacao_id, user_id, bling_id, nome) values ($1, $2, $3, '76009', 'Cliente sintético')",
    [CLIENTE_ID, ORG_ID, OWNER_ID],
  );
  await client.query(
    `insert into public.pedidos (id, organizacao_id, user_id, bling_id, numero, data, cliente_id, total)
     values ($1, $2, $3, '76010', '76010', now(), $4, 20)`,
    [PEDIDO_ID, ORG_ID, OWNER_ID, CLIENTE_ID],
  );
  await client.query(
    `insert into public.itens_pedido (organizacao_id, user_id, pedido_id, produto_id, quantidade, valor_unitario)
     values ($1, $2, $3, $4, 2, 10)`,
    [ORG_ID, OWNER_ID, PEDIDO_ID, PRODUTO_A],
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
    return err('TombstoneRaceInicioFalhou', 'A primeira chamada falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('TombstoneRaceNaoBloqueou', 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linha, b: await promiseB, waitEvent: observacao.waitEvent });
}

const SQL_EXCLUIR = 'select * from public.registrar_exclusao_de_produto_no_bling($1, $2, null)';
/** O upsert do espelho (`produtoRepository.upsert`), como o update atrasado o faria. */
const SQL_UPSERT = `insert into public.produtos (organizacao_id, user_id, bling_id, nome, preco, estoque)
  values ($1, $2, $3, 'Recriado pelo update atrasado', 99, 1)
  on conflict (organizacao_id, bling_id) do update set nome = excluded.nome, preco = excluded.preco, estoque = excluded.estoque
  returning id`;

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runTombstoneRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-tombstone'),
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

    const exclusaoPrimeiro = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_EXCLUIR, paramsA: [ORG_ID, '76001'],
      sqlB: SQL_UPSERT, paramsB: [ORG_ID, OWNER_ID, '76001'],
    });
    if (exclusaoPrimeiro._tag === 'err') return exclusaoPrimeiro;
    const a = (await admin.query('select situacao, nome, preco from public.produtos where id = $1', [PRODUTO_A])).rows[0];
    const itens = (await admin.query('select count(*)::int as n from public.itens_pedido where produto_id = $1', [PRODUTO_A])).rows[0].n;
    if (exclusaoPrimeiro.value.a.desfecho !== 'registrado' || exclusaoPrimeiro.value.b.ok || exclusaoPrimeiro.value.b.code !== '23514'
        || a.situacao !== 'arquivado' || a.nome !== 'Produto A' || Number(a.preco) !== 10 || itens !== 1) {
      return err('TombstoneRaceRessuscitou', 'O update atrasado concorrente regravou o produto excluído', { b: exclusaoPrimeiro.value.b, produto: a, itens });
    }

    const gravacaoPrimeiro = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_UPSERT, paramsA: [ORG_ID, OWNER_ID, '76002'],
      sqlB: SQL_EXCLUIR, paramsB: [ORG_ID, '76002'],
    });
    if (gravacaoPrimeiro._tag === 'err') return gravacaoPrimeiro;
    const novo = (await admin.query("select situacao from public.produtos where organizacao_id = $1 and bling_id = '76002'", [ORG_ID])).rows[0];
    if (!gravacaoPrimeiro.value.b.ok || gravacaoPrimeiro.value.b.linha.desfecho !== 'registrado' || novo?.situacao !== 'arquivado') {
      return err('TombstoneRacePerdeuProduto', 'A exclusão que esperou a gravação não arquivou o produto', { b: gravacaoPrimeiro.value.b, produto: novo });
    }

    const duas = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_EXCLUIR, paramsA: [ORG_ID, '76003'],
      sqlB: SQL_EXCLUIR, paramsB: [ORG_ID, '76003'],
    });
    if (duas._tag === 'err') return duas;
    const tombstones = (await admin.query(
      "select count(*)::int as n from public.produtos_excluidos_no_bling where organizacao_id = $1 and bling_id = '76003'", [ORG_ID])).rows[0].n;
    if (duas.value.a.desfecho !== 'registrado_sem_produto' || duas.value.b.linha?.desfecho !== 'ja_registrado' || tombstones !== 1) {
      return err('TombstoneRaceDuplicou', 'Duas exclusões concorrentes não convergiram para uma tombstone', { b: duas.value.b, tombstones });
    }

    return ok(Object.freeze({
      relato: `tombstone provada com bloqueio observado no Postgres nas DUAS ordens: exclusão → upsert atrasado `
        + `(wait_event=${exclusaoPrimeiro.value.waitEvent}) recusado com ${exclusaoPrimeiro.value.b.code}, produto ${a.situacao} `
        + `com nome e preço intactos e ${itens} item de pedido; gravação → exclusão (wait_event=${gravacaoPrimeiro.value.waitEvent}) `
        + `arquivou o produto recém-gravado; duas exclusões simultâneas (wait_event=${duas.value.waitEvent}) deram `
        + `${duas.value.a.desfecho} e ${duas.value.b.linha.desfecho} com ${tombstones} tombstone`,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('TombstoneRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência da tombstone', {}, cause);
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
