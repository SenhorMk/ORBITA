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
 * MECANISMO, e prova FORCANDO a sobreposicao — nao apenas disparando duas
 * promises sem `await` entre elas e confiando que o Postgres as intercalou.
 * Duas promises iniciadas juntas podem, legitimamente, terminar em serie (A
 * comeca, A termina, so entao B comeca de verdade) sem que o teste perceba —
 * ficaria verde por sorte de agendamento, nao por prova.
 *
 * A BARREIRA DETERMINISTICA, em cinco passos — e por que um temporizador NAO
 * BASTA (achado da 3ª rodada de revisão): raciar a promise de B contra um
 * `setTimeout` e ver que ela "ainda não resolveu" prova só isso — que não
 * resolveu. Não prova que B alcançou o `INSERT ... ON CONFLICT` e está presa
 * nele; B podia simplesmente não ter chegado ainda ao Postgres quando o
 * temporizador venceu. A prova real tem de vir DO PRÓPRIO BANCO:
 *
 *   1. Conexao A abre uma transacao EXPLICITA (`BEGIN`) e chama a RPC. O
 *      trabalho da funcao acontece dentro dessa transacao aberta — o
 *      `INSERT ... ON CONFLICT` toma o bloqueio da linha, mas nada e
 *      commitado ainda.
 *   2. Conexao B, numa transacao implicita normal (como a producao faz),
 *      dispara a MESMA chamada. Ela bate no bloqueio que A segura.
 *   3. O rehearsal consulta `pg_stat_activity` (de uma TERCEIRA conexão,
 *      administrativa) pelo `pid` de B, em polling curto, até observar
 *      `wait_event_type = 'Lock'` — o próprio Postgres marcando que aquela
 *      sessão está parada esperando outra transação. Essa é a prova: não
 *      "B não respondeu a tempo", e sim "o banco confirma que B está
 *      bloqueada". Ver `observarBloqueioNoPostgres`.
 *   4. So entao A commita (`COMMIT`).
 *   5. B destrava, reavalia sua clausula `WHERE` contra o estado JA
 *      commitado por A, e perde com `23505`.
 *
 * Se `pg_stat_activity` nunca marcar B como esperando um Lock dentro do
 * orçamento (passo 3 falhando), o rehearsal reprova com
 * `ManualOrderRaceNaoBloqueou` — isso significaria que a sobreposição não foi
 * observada de verdade, e o resultado do resto do teste não provaria
 * concorrência real.
 */

const ORG_ID = 'c0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'c0000000-0000-4000-8000-000000000002';
const CLIENTE_ID = 'c0000000-0000-4000-8000-000000000003';
const PRODUTO_ID = 'c0000000-0000-4000-8000-000000000004';
const PEDIDO_WEBHOOK_ID = 'c0000000-0000-4000-8000-000000000005';
const BLING_PEDIDO_ID = '99999999999';

/** Quanto tempo o rehearsal espera antes de checar se B ainda está bloqueada. */
const JANELA_DE_OBSERVACAO_DO_BLOQUEIO_MS = 300;

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

const SQL_ASSUMIR = `select public.registrar_venda_manual($1,$2,$3,$4,$4,10.00,0,0,'Dinheiro',null,current_date,$5::jsonb) as pedido_id`;
const PARAMS_ASSUMIR = [
  ORG_ID,
  OWNER_ID,
  CLIENTE_ID,
  BLING_PEDIDO_ID,
  JSON.stringify([{ produto_id: PRODUTO_ID, quantidade: 1, valor_unitario: 10.0 }]),
];

/**
 * Dispara a tomada e devolve o resultado observavel — nunca lanca.
 *
 * @param {import('pg').Client} client - Conexao dedicada a esta tentativa.
 * @returns {Promise<{ readonly ok: true, readonly pedidoId: string } | { readonly ok: false, readonly code: string | undefined }>} Resultado observavel da chamada.
 */
async function tentarAssumirLinha(client) {
  try {
    const result = await client.query(SQL_ASSUMIR, PARAMS_ASSUMIR);
    return { ok: true, pedidoId: result.rows[0]?.pedido_id };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined };
  }
}

/**
 * Espera um número fixo de milissegundos, sem cancelamento — só para o
 * intervalo entre tentativas de observação do bloqueio.
 *
 * @param {number} ms - Milissegundos a esperar.
 * @returns {Promise<void>}
 */
function esperar(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Observa, no PRÓPRIO POSTGRES — não por passagem de tempo — que a conexão
 * `pid` está de fato esperando um bloqueio de linha.
 *
 * A revisão apontou, corretamente, que raciar uma promise contra um
 * temporizador e ver que ela "ainda não resolveu" não prova que B alcançou o
 * `INSERT ... ON CONFLICT` e está presa nele — B podia simplesmente não ter
 * chegado ainda ao Postgres. A prova real está em `pg_stat_activity`: quando
 * uma sessão bloqueia esperando outra transação liberar uma linha, o próprio
 * Postgres marca essa sessão com `wait_event_type = 'Lock'` (mecanismo
 * `LOCKTAG_TRANSACTION` — B espera o XID de A terminar, não um lock de linha
 * direto, mas o sinal observável é o mesmo). Isso é atualizado pelo backend
 * de B em tempo real, não por polling arriscado do lado do cliente.
 *
 * @param {import('pg').Client} adminClient - Conexão livre para consultar `pg_stat_activity`.
 * @param {number} pid - `pg_backend_pid()` da conexão que deveria estar bloqueada.
 * @param {{ readonly timeoutMs?: number, readonly intervaloDePollMs?: number }} [opcoes] - Orçamento de espera e intervalo entre consultas.
 * @returns {Promise<{ readonly observado: true, readonly waitEvent: string | null } | { readonly observado: false }>} Se e como o bloqueio foi observado.
 */
async function observarBloqueioNoPostgres(adminClient, pid, { timeoutMs = 3000, intervaloDePollMs = 20 } = {}) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const resultado = await adminClient.query(
      `select wait_event_type, wait_event, state from pg_stat_activity where pid = $1`,
      [pid],
    );
    const linha = resultado.rows[0];
    if (linha && linha.wait_event_type === 'Lock') {
      return { observado: true, waitEvent: linha.wait_event ?? null };
    }
    await esperar(intervaloDePollMs);
  }
  return { observado: false };
}

/**
 * Prova, contra Postgres real e com uma barreira determinística de
 * concorrência, que duas vendas manuais tentando assumir a MESMA linha do
 * webhook nunca produzem duas vencedoras nem uma linha corrompida.
 *
 * @param {object} [options] - Fabrica de clientes e janela de observação injetáveis para teste.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidencia da corrida ou falha tagueada.
 */
export async function runManualOrderRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency'),
  timeoutDeObservacaoMs = JANELA_DE_OBSERVACAO_DO_BLOQUEIO_MS,
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  try {
    await admin.connect();
    await seedWebhookRow(admin);

    await clientA.connect();
    await clientB.connect();

    // ---- Passo 1: A abre transação explícita e toma a linha, SEM commitar. ----
    await clientA.query('BEGIN');
    const resultadoA = await tentarAssumirLinha(clientA);
    if (!resultadoA.ok) {
      await clientA.query('ROLLBACK');
      return err(
        'ManualOrderRacePrimeiraTentativaFalhou',
        'A primeira tentativa (dentro da transação aberta) deveria ter vencido a linha limpa; falhou antes de haver concorrência',
        { resultadoA },
      );
    }

    // ---- Passo 2: B dispara a mesma tomada, na mesma chave, SEM esperar A. ----
    const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
    const promiseB = tentarAssumirLinha(clientB);

    // ---- Passo 3: observa NO POSTGRES, via pg_stat_activity, que B está
    // genuinamente esperando o bloqueio que A segura — não por passagem de
    // tempo. Se B já tivesse terminado (não bloqueado de verdade), essa
    // consulta simplesmente não encontraria `wait_event_type = 'Lock'` para
    // o pid dela dentro do orçamento, e o rehearsal reprova abaixo.
    const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
    if (!observacao.observado) {
      // B pode ter terminado sozinha (sem bloquear) ou o Postgres pode não
      // ter marcado o wait a tempo. De qualquer forma, a sobreposição não
      // foi PROVADA — reprova aqui, explicitamente, em vez de seguir supondo.
      await clientA.query('ROLLBACK').catch(() => {});
      const resultadoBSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
      return err(
        'ManualOrderRaceNaoBloqueou',
        'pg_stat_activity nunca marcou a conexão B como esperando um Lock enquanto A segurava a transação aberta — a sobreposição real não foi observada no banco',
        { pidDeB, timeoutDeObservacaoMs, resultadoBSeJaResolveu },
      );
    }

    // ---- Passo 4: só agora, com o bloqueio de B confirmado no Postgres,
    // A commita — libera o que B espera. ----
    await clientA.query('COMMIT');

    // ---- Passo 5: B destrava e reavalia contra o estado já commitado. ----
    const resultadoB = await promiseB;

    if (resultadoB.ok) {
      return err(
        'ManualOrderRaceDoubleWinner',
        'B deveria perder — a linha já pertencia à venda manual de A quando B reavaliou sua cláusula WHERE — mas B também venceu',
        { resultadoA, resultadoB },
      );
    }
    if (resultadoB.code !== '23505') {
      return err(
        'ManualOrderRaceWrongFailure',
        'A tentativa perdedora deveria falhar com 23505 (guarda da migration 57), não com outra causa',
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
        `Esperava exatamente UMA linha de pedido para o bling_id após a corrida; encontrou ${linhas.rows.length}`,
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
        `O estoque físico deveria cair exatamente 1 (5 -> 4) mesmo com a barreira de concorrência real; ficou em ${linha.estoque_final}`,
        { estoqueFinal: linha.estoque_final },
      );
    }
    if (Number(linha.estoque_reservado_final) !== 0) {
      return err(
        'ManualOrderRaceReservationLeaked',
        `A reserva deveria terminar em 0 (migration 58) mesmo sob concorrência real; ficou em ${linha.estoque_reservado_final}`,
        { estoqueReservadoFinal: linha.estoque_reservado_final },
      );
    }

    return ok(Object.freeze({
      vencedora: resultadoA.pedidoId,
      perdedoraCode: resultadoB.code,
      bloqueioObservadoNoPostgres: observacao.waitEvent,
      estoqueFinal: Number(linha.estoque_final),
      estoqueReservadoFinal: Number(linha.estoque_reservado_final),
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('ManualOrderRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência da venda manual', {}, cause);
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
