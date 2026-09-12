import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

/**
 * Corrida do MESMO item: duas transações aplicando o upsert de
 * `PedidoRepository.addItems` para a mesma chave `(pedido_id, produto_id)`.
 *
 * ## O que o pgTAP não alcança
 *
 * `supabase/tests/database/replay_de_item_nao_consome_estoque.test.sql` prova
 * a aritmética do delta numa transação só. O que ele não pode exercitar é a
 * ordem de travamento: a leitura da demanda vigente e a leitura da
 * disponibilidade precisam vir do mesmo ponto de serialização, e isso só
 * aparece quando duas transações se cruzam.
 *
 * Com a leitura da linha antes do travamento do produto, T2 comparava reserva
 * NOVA contra demanda vigente VELHA e recusava um replay com
 * `check_violation` — recusa falsa, porque o efeito real de T2 é delta zero.
 *
 * Invariante provado aqui: **reaplicar o mesmo estado não consome estoque, nem
 * sob concorrência** — uma linha só, quantidade 1, reserva incrementada
 * exatamente uma vez, nunca negativa, e nenhuma rejeição falsa.
 */

const ORG_ID = 'c9000000-0000-4000-8000-000000000001';
const OWNER_ID = 'c9000000-0000-4000-8000-000000000002';
const CLIENTE_ID = 'c9000000-0000-4000-8000-000000000003';
const PRODUTO_ID = 'c9000000-0000-4000-8000-00000000000a';
const PEDIDO_ID = 'c9000000-0000-4000-8000-00000000000b';

/** O upsert exato que `PedidoRepository.addItems` emite. */
const UPSERT_DO_ADD_ITEMS = `
  insert into public.itens_pedido (organizacao_id, user_id, pedido_id, produto_id, quantidade, valor_unitario)
  values ($1, $2, $3, $4, $5, 40.00)
  on conflict (pedido_id, produto_id)
  do update set quantidade = excluded.quantidade, valor_unitario = excluded.valor_unitario
`;

/** Disponibilidade para exatamente UMA unidade, e pedido que reserva. */
async function semear(client, { comLinhaInicial }) {
  await client.query('delete from public.itens_pedido where pedido_id = $1', [PEDIDO_ID]);
  await client.query('delete from public.pedidos where id = $1', [PEDIDO_ID]);
  await client.query('delete from public.produtos where id = $1', [PRODUTO_ID]);
  await client.query('delete from public.clientes where id = $1', [CLIENTE_ID]);
  await client.query('delete from public.membros_organizacao where organizacao_id = $1', [ORG_ID]);
  await client.query('delete from public.organizacoes where id = $1', [ORG_ID]);
  await client.query('delete from auth.users where id = $1', [OWNER_ID]);

  await client.query("insert into auth.users (id, email) values ($1, 'owner-replay@orbita.test')", [OWNER_ID]);
  await client.query(
    "insert into public.organizacoes (id, nome, slug, status) values ($1, 'Org Replay', 'org-replay', 'active')",
    [ORG_ID],
  );
  await client.query(
    "insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')",
    [ORG_ID, OWNER_ID],
  );
  await client.query(
    "insert into public.clientes (id, organizacao_id, user_id, bling_id, nome) values ($1, $2, $3, '77001', 'Cliente Replay')",
    [CLIENTE_ID, ORG_ID, OWNER_ID],
  );
  await client.query(
    `insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, estoque, estoque_reservado)
     values ($1, $2, $3, '88001', 'Produto Replay', 1, 0)`,
    [PRODUTO_ID, ORG_ID, OWNER_ID],
  );
  // Pedido do Bling e `Pendente`: contribui para reserva.
  await client.query(
    `insert into public.pedidos (id, organizacao_id, user_id, cliente_id, bling_id, numero, data, total, status, origem)
     values ($1, $2, $3, $4, '99001', '99001', now(), 40.00, 'Pendente', 'Bling')`,
    [PEDIDO_ID, ORG_ID, OWNER_ID, CLIENTE_ID],
  );

  if (comLinhaInicial) {
    await client.query(UPSERT_DO_ADD_ITEMS, [ORG_ID, OWNER_ID, PEDIDO_ID, PRODUTO_ID, 1]);
  }
}

async function lerEstado(client) {
  const produto = await client.query(
    'select estoque, estoque_reservado from public.produtos where id = $1',
    [PRODUTO_ID],
  );
  const itens = await client.query(
    `select count(*)::int as linhas, coalesce(sum(quantidade), 0)::int as quantidade
       from public.itens_pedido where pedido_id = $1`,
    [PEDIDO_ID],
  );
  return {
    estoque: produto.rows[0].estoque,
    reservado: produto.rows[0].estoque_reservado,
    linhas: itens.rows[0].linhas,
    quantidade: itens.rows[0].quantidade,
  };
}

/**
 * Encena a sobreposição: T1 aplica e NÃO commita, T2 aplica o mesmo estado
 * enquanto a linha de T1 é invisível, e só então T1 commita.
 */
async function encenar({ criarCliente, comLinhaInicial, sobreposicaoMs }) {
  const base = criarCliente();
  await base.connect();
  await semear(base, { comLinhaInicial });
  const antes = await lerEstado(base);

  const t1 = criarCliente();
  const t2 = criarCliente();
  await t1.connect();
  await t2.connect();

  const falhas = { t1: null, t2: null };
  try {
    await t1.query('begin');
    await t2.query('begin');

    await t1.query(UPSERT_DO_ADD_ITEMS, [ORG_ID, OWNER_ID, PEDIDO_ID, PRODUTO_ID, 1]).catch((erro) => {
      falhas.t1 = erro.code ?? 'sem-codigo';
    });

    const t2EmVoo = t2
      .query(UPSERT_DO_ADD_ITEMS, [ORG_ID, OWNER_ID, PEDIDO_ID, PRODUTO_ID, 1])
      .then(() => {}, (erro) => { falhas.t2 = erro.code ?? 'sem-codigo'; });

    await new Promise((resolve) => setTimeout(resolve, sobreposicaoMs));
    await t1.query('commit');
    await t2EmVoo;
    await t2.query('commit').catch(() => t2.query('rollback').catch(() => {}));
  } finally {
    await t1.end().catch(() => {});
    await t2.end().catch(() => {});
  }

  const depois = await lerEstado(base);
  await base.end().catch(() => {});
  return { antes, depois, falhas };
}

/** Os invariantes que valem nas duas corridas. */
function violacoes({ antes, depois, falhas }) {
  const problemas = [];
  for (const [transacao, codigo] of Object.entries(falhas)) {
    if (codigo === '23514') problemas.push(`${transacao} recusada por 23514 (rejeição falsa)`);
    else if (codigo !== null) problemas.push(`${transacao} falhou com ${codigo}`);
  }
  if (depois.linhas !== 1) problemas.push(`linhas=${depois.linhas}, esperado 1`);
  if (depois.quantidade !== 1) problemas.push(`quantidade=${depois.quantidade}, esperado 1`);
  if (depois.estoque !== antes.estoque) problemas.push(`estoque mudou ${antes.estoque}->${depois.estoque}`);
  if (depois.reservado !== 1) problemas.push(`reservado=${depois.reservado}, esperado 1`);
  if (depois.reservado < 0) problemas.push('reserva negativa');
  return problemas;
}

/**
 * @param {object} options
 * @param {() => import('pg').Client} [options.createClient] - Fábrica de cliente do laboratório.
 * @param {number} [options.sobreposicaoMs] - Janela em que T1 fica aberta com T2 já disparada.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: { readonly relato: string } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>}
 */
export async function runItemReplayRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-replay'),
  sobreposicaoMs = 800,
} = {}) {
  try {
    const semLinha = await encenar({ criarCliente: createClient, comLinhaInicial: false, sobreposicaoMs });
    const comLinha = await encenar({ criarCliente: createClient, comLinhaInicial: true, sobreposicaoMs });

    const problemas = [
      ...violacoes(semLinha).map((p) => `sem linha inicial: ${p}`),
      ...violacoes(comLinha).map((p) => `linha existente: ${p}`),
    ];

    if (problemas.length > 0) {
      return err(
        'ItemReplayRaceViolated',
        `corrida do mesmo item violou o invariante: ${problemas.join(' | ')}`,
        { problemas },
      );
    }

    return ok(Object.freeze({
      relato:
        'corrida do mesmo item provada nas DUAS partidas: sem linha inicial e com linha existente, '
        + 'duas transações aplicando quantidade 1 deixam uma única linha com quantidade 1, '
        + `estoque intacto (${semLinha.depois.estoque}) e reserva incrementada exatamente uma vez `
        + `(${semLinha.depois.reservado}), sem nenhuma recusa por 23514`,
    }));
  } catch (cause) {
    return err('ItemReplayRaceFailed', 'não foi possível encenar a corrida do mesmo item', {}, cause);
  }
}
