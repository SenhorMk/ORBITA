import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

/**
 * Ticket 30 — prova de atomicidade da "tomada" da linha do webhook.
 *
 * `registrar_venda_manual` (migration 57) assume a linha do webhook com um
 * unico `INSERT ... ON CONFLICT (organizacao_id, bling_id) DO UPDATE ...
 * WHERE pedidos.origem <> 'Loja Física / Manual'`. Isso e uma afirmacao
 * estrutural sobre o Postgres — nao ha leitura -> decisao -> escrita em
 * instrucoes separadas, e portanto nao ha janela entre elas onde duas
 * transacoes possam ambas decidir "esta linha esta livre" e ambas assumirem.
 *
 * O pgTAP prova o RESULTADO (uma chamada por vez). Este modulo prova o
 * MECANISMO: abre DUAS conexoes reais, dispara as duas chamadas
 * concorrentemente contra a MESMA linha, e mede o que o Postgres realmente
 * fez sob concorrencia — nao o que o codigo assume que ele faz.
 *
 * O mecanismo: `INSERT ... ON CONFLICT` obtem, para a chave em conflito, o
 * mesmo bloqueio de linha que um `UPDATE` obteria. A segunda transacao a
 * tentar a mesma chave BLOQUEIA no indice unico ate a primeira commitar (a
 * funcao inteira e uma transacao implicita — sem BEGIN/COMMIT explicito no
 * lado do cliente) e SO ENTAO reavalia sua propria clausula `WHERE` contra o
 * estado ja commitado. E o commit da primeira, por definicao, ja mudou
 * `origem` para 'Loja Física / Manual' — entao a segunda tentativa nunca ve
 * uma linha livre, mesmo tendo iniciado a decisao antes do commit da
 * primeira. Isso e o que se prova aqui.
 */

const ORG_ID = 'c0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'c0000000-0000-4000-8000-000000000002';
const CLIENTE_ID = 'c0000000-0000-4000-8000-000000000003';
const PRODUTO_ID = 'c0000000-0000-4000-8000-000000000004';
const PEDIDO_WEBHOOK_ID = 'c0000000-0000-4000-8000-000000000005';
const BLING_PEDIDO_ID = '99999999999';

/**
 * Semeia o estado exato da corrida: um pedido ja gravado pelo webhook
 * (`origem = 'Bling'`, `status = 'Pendente'`), pronto para duas vendas
 * manuais tentarem assumi-lo ao mesmo tempo.
 *
 * @param {import('pg').Client} client - Conexao administrativa para o seed.
 * @returns {Promise<void>}
 */
async function seedWebhookRow(client) {
  await client.query(`
    insert into auth.users (id, email) values ($1, 'owner-concorrencia-t30@orbita.test')
    on conflict (id) do nothing
  `, [OWNER_ID]);
  await client.query(`
    insert into public.organizacoes (id, nome, slug) values ($1, 'Org Concorrencia T30', 'org-concorrencia-t30')
    on conflict (id) do nothing
  `, [ORG_ID]);
  await client.query(`
    insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')
    on conflict (organizacao_id, user_id) do nothing
  `, [ORG_ID, OWNER_ID]);
  await client.query(`
    insert into public.clientes (id, user_id, organizacao_id, bling_id, nome)
    values ($1, $2, $3, '321', 'Cliente Concorrencia')
    on conflict (id) do nothing
  `, [CLIENTE_ID, OWNER_ID, ORG_ID]);
  await client.query(`
    insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque)
    values ($1, $2, $3, '654', 'Produto Concorrencia', 10.00, 5)
    on conflict (id) do nothing
  `, [PRODUTO_ID, OWNER_ID, ORG_ID]);
  await client.query(`
    insert into public.pedidos (id, user_id, organizacao_id, cliente_id, bling_id, numero, data, total, status, origem)
    values ($1, $2, $3, $4, $5, '1', current_date, 10.00, 'Pendente', 'Bling')
    on conflict (id) do nothing
  `, [PEDIDO_WEBHOOK_ID, OWNER_ID, ORG_ID, CLIENTE_ID, BLING_PEDIDO_ID]);
  // O item que o webhook teria gravado, reservando 1 unidade enquanto o
  // pedido ainda e `Pendente` — e o que a migration 58 tem de liberar quando
  // a venda manual (qualquer uma das duas) mudar o status para `Entregue`.
  await client.query(`
    insert into public.itens_pedido (user_id, organizacao_id, pedido_id, produto_id, quantidade, valor_unitario)
    values ($1, $2, $3, $4, 1, 10.00)
    on conflict (pedido_id, produto_id) do nothing
  `, [OWNER_ID, ORG_ID, PEDIDO_WEBHOOK_ID, PRODUTO_ID]);
}

/**
 * Dispara a RPC de venda manual numa conexao propria, assumindo a linha do
 * webhook semeada acima.
 *
 * @param {import('pg').Client} client - Conexao dedicada a esta tentativa.
 * @returns {Promise<{ readonly ok: true, readonly pedidoId: string } | { readonly ok: false, readonly code: string | undefined }>} Resultado observavel da chamada.
 */
async function tentarAssumirLinha(client) {
  try {
    const result = await client.query(
      `select public.registrar_venda_manual($1,$2,$3,$4,$4,10.00,0,0,'Dinheiro',null,current_date,$5::jsonb) as pedido_id`,
      [
        ORG_ID,
        OWNER_ID,
        CLIENTE_ID,
        BLING_PEDIDO_ID,
        JSON.stringify([{ produto_id: PRODUTO_ID, quantidade: 1, valor_unitario: 10.0 }]),
      ],
    );
    return { ok: true, pedidoId: result.rows[0]?.pedido_id };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined };
  }
}

/**
 * Prova, contra Postgres real e duas conexoes reais, que duas vendas manuais
 * concorrentes tentando assumir a MESMA linha do webhook nunca produzem duas
 * vencedoras nem uma linha corrompida.
 *
 * @param {object} [options] - Fabrica de clientes injetavel para teste.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidencia da corrida ou falha tagueada.
 */
export async function runManualOrderRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency'),
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  try {
    await admin.connect();
    await seedWebhookRow(admin);

    await clientA.connect();
    await clientB.connect();

    // As duas chamadas saem SEM await entre elas: os dois sockets recebem a
    // query quase no mesmo instante, e e o Postgres — nao o Node — quem
    // decide a ordem. `allSettled`, nao `all`: uma das duas DEVE rejeitar
    // (23505), e isso e o resultado esperado, nao uma falha do rehearsal.
    const [resultadoA, resultadoB] = await Promise.all([
      tentarAssumirLinha(clientA),
      tentarAssumirLinha(clientB),
    ]);

    const sucessos = [resultadoA, resultadoB].filter((r) => r.ok);
    const falhas = [resultadoA, resultadoB].filter((r) => !r.ok);

    if (sucessos.length !== 1) {
      return err(
        'ManualOrderRaceDoubleWinner',
        `Esperava exatamente UMA tentativa vencedora sob concorrencia real; ${sucessos.length} venceram`,
        { resultadoA, resultadoB },
      );
    }
    if (falhas.length !== 1 || falhas[0].code !== '23505') {
      return err(
        'ManualOrderRaceWrongFailure',
        'A tentativa perdedora deveria falhar com 23505 (guarda da migration 57), nao com outra causa',
        { resultadoA, resultadoB },
      );
    }

    const linhas = await admin.query(
      `select origem, estoque_reservado_final, estoque_final from (
         select p.origem,
                (select estoque_reservado from public.produtos where id = $2) as estoque_reservado_final,
                (select estoque from public.produtos where id = $2) as estoque_final
         from public.pedidos p where p.organizacao_id = $1 and p.bling_id = $3
       ) t`,
      [ORG_ID, PRODUTO_ID, BLING_PEDIDO_ID],
    );

    if (linhas.rows.length !== 1) {
      return err(
        'ManualOrderRaceRowCount',
        `Esperava exatamente UMA linha de pedido para o bling_id apos a corrida; encontrou ${linhas.rows.length}`,
        { rows: linhas.rows.length },
      );
    }
    const [linha] = linhas.rows;
    if (linha.origem !== 'Loja Física / Manual') {
      return err('ManualOrderRaceWrongOrigem', `A linha vencedora deveria ter origem de venda manual; tinha "${linha.origem}"`, {});
    }
    if (Number(linha.estoque_final) !== 4) {
      return err(
        'ManualOrderRaceStockDoubleDebited',
        `O estoque fisico deveria cair exatamente 1 (5 -> 4) mesmo com as duas tentativas concorrentes; ficou em ${linha.estoque_final}`,
        { estoqueFinal: linha.estoque_final },
      );
    }
    if (Number(linha.estoque_reservado_final) !== 0) {
      return err(
        'ManualOrderRaceReservationLeaked',
        `A reserva deveria terminar em 0 (migration 58) mesmo sob concorrencia; ficou em ${linha.estoque_reservado_final}`,
        { estoqueReservadoFinal: linha.estoque_reservado_final },
      );
    }

    return ok(Object.freeze({
      vencedora: sucessos[0].pedidoId,
      perdedoraCode: falhas[0].code,
      estoqueFinal: Number(linha.estoque_final),
      estoqueReservadoFinal: Number(linha.estoque_reservado_final),
    }));
  } catch (cause) {
    return err('ManualOrderRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrencia da venda manual', {}, cause);
  } finally {
    for (const client of [admin, clientA, clientB]) {
      try {
        await client.end();
      } catch {
        // Encerramento de conexao de teste; nada a fazer se ja caiu.
      }
    }
  }
}
