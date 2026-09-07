import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

/**
 * Ticket 30, fatia 3 — 8ª rodada de revisão.
 *
 * Prova o FENCING: depois que uma reconciliação toma posse de uma tentativa
 * antiga, o executor anterior não pode continuar concluindo efeitos como se
 * ainda fosse dono dela.
 *
 * ## O entrelaçamento que a 7ª rodada deixava aberto
 *
 * O CAS da 7ª rodada protegia UM sentido: handler conclui primeiro, e a
 * reconciliação perde o compare-and-set. O sentido inverso ficava exposto,
 * porque o handler grava seus desfechos **sem** `estadoEsperado` — de
 * propósito, já que ele sabe o que aconteceu:
 *
 *   1. tentativa `em_andamento`, handler original ainda VIVO;
 *   2. passa a idade mínima;
 *   3. reconciliação lê `em_andamento` e vence;
 *   4. a tentativa sai do índice parcial de pendências;
 *   5. outra venda idêntica consegue abrir;
 *   6. o handler antigo retoma e grava incondicionalmente, por cima.
 *
 * O resultado é o pior possível: duas vendas idênticas abertas, e o ledger
 * dizendo o que o executor zumbi escreveu por último.
 *
 * ## A prova
 *
 * Não precisa de duas conexões disputando um lock: precisa de ORDEM. O
 * rehearsal encena a sequência acima passo a passo, contra PostgreSQL real, e
 * verifica no fim quem conseguiu escrever.
 *
 * - **`esperado: 'sem-fencing'`** — reproduz o defeito: o handler antigo
 *   consegue concluir depois de perder a posse.
 * - **`esperado: 'com-fencing'`** — prova a correção: a escrita do handler
 *   antigo é recusada com `55P03`, e o estado permanece o que a reconciliação
 *   gravou.
 */

const ORG_ID = 'e0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'e0000000-0000-4000-8000-000000000002';
const REFERENCIA = 'ORBITA-fencing-original';
const REFERENCIA_SEGUNDA = 'ORBITA-fencing-segunda-venda';
const FINGERPRINT = 'fingerprint-fencing';
const VALORES = 'valores-fencing';

async function seed(client) {
  await client.query(
    `insert into auth.users (id, email) values ($1, 'owner-fencing-t30@orbita.test') on conflict (id) do nothing`,
    [OWNER_ID],
  );
  await client.query(
    `insert into public.organizacoes (id, nome, slug) values ($1, 'Org Fencing T30', 'org-fencing-t30')
     on conflict (id) do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')
     on conflict (organizacao_id, user_id) do nothing`,
    [ORG_ID, OWNER_ID],
  );
}

async function reivindicar(client, referencia) {
  const { rows } = await client.query(
    `select * from public.reivindicar_tentativa_venda_manual($1, $2, $3, $4)`,
    [ORG_ID, referencia, FINGERPRINT, VALORES],
  );
  return rows[0];
}

/** Executa e devolve o desfecho observável, sem lançar. */
async function tentar(client, sql, params) {
  try {
    await client.query(sql, params);
    return { ok: true };
  } catch (cause) {
    return { ok: false, code: cause?.code, message: cause?.message };
  }
}

/**
 * @param {object} [options] - Fábrica de cliente e expectativa.
 * @param {'com-fencing' | 'sem-fencing'} [options.esperado] - O que se espera observar.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runFencingRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-fencing'),
  esperado = 'com-fencing',
} = {}) {
  const client = createClient();
  try {
    await client.connect();
    await seed(client);

    // ---- 1. O handler original reivindica e vira dono. ----
    const original = await reivindicar(client, REFERENCIA);
    if (!original.tentativa_id) {
      return err('FencingReivindicacaoFalhou', 'A reivindicação original deveria ter sido autorizada', { original });
    }
    const epocaDoOriginal = original.epoca;

    // ---- 2/3. Passa a idade mínima; a reconciliação lê o estado atual. ----
    await client.query(
      `update public.tentativas_venda_manual set updated_at = now() - interval '10 minutes' where id = $1`,
      [original.tentativa_id],
    );
    const { rows: lidas } = await client.query(
      `select estado, epoca from public.tentativas_venda_manual where id = $1`,
      [original.tentativa_id],
    );
    const epocaLidaPelaReconciliacao = lidas[0].epoca;

    // ---- 4. A reconciliação TOMA A POSSE (só existe com fencing). ----
    let epocaDaReconciliacao = epocaLidaPelaReconciliacao;
    if (esperado === 'com-fencing') {
      const { rows: assumidas } = await client.query(
        // O estado esperado entra junto com a epoca desde a 9a rodada (B6):
        // a epoca sozinha nao registra que o estado andou.
        `select public.assumir_tentativa_para_reconciliacao($1, $2, $3, 'em_andamento') as epoca`,
        [ORG_ID, original.tentativa_id, epocaLidaPelaReconciliacao],
      );
      epocaDaReconciliacao = assumidas[0].epoca;
      if (epocaDaReconciliacao === epocaDoOriginal) {
        return err('FencingEpocaNaoAvancou', 'Tomar posse deveria avançar a época', { epocaDoOriginal, epocaDaReconciliacao });
      }
    }

    // ---- 5. A reconciliação conclui a tentativa e libera o fingerprint. ----
    await client.query(
      `select public.concluir_tentativa_venda_manual($1, $2, 'falhou', null, null, null, $3)`,
      [ORG_ID, original.tentativa_id, esperado === 'com-fencing' ? epocaDaReconciliacao : null],
    );

    // ---- 6. Outra venda idêntica consegue abrir (o fingerprint saiu do índice). ----
    const segunda = await reivindicar(client, REFERENCIA_SEGUNDA);
    if (!segunda.tentativa_id) {
      return err('FencingSegundaVendaBloqueada', 'Depois de a tentativa antiga ser encerrada, a venda idêntica deveria abrir', { segunda });
    }

    // ---- 7. O HANDLER ANTIGO RETOMA e tenta concluir, como sempre fez. ----
    const escritaDoZumbi = await tentar(
      client,
      `select public.concluir_tentativa_venda_manual($1, $2, 'concluida', null, '918273', null, $3)`,
      [ORG_ID, original.tentativa_id, esperado === 'com-fencing' ? epocaDoOriginal : null],
    );

    const { rows: finais } = await client.query(
      `select estado, bling_pedido_id, epoca from public.tentativas_venda_manual where id = $1`,
      [original.tentativa_id],
    );
    const estadoFinal = finais[0];

    if (esperado === 'sem-fencing') {
      if (!escritaDoZumbi.ok || estadoFinal.estado !== 'concluida') {
        return err(
          'FencingDefeitoNaoReproduzido',
          'Esperava reproduzir o executor antigo escrevendo por cima depois de perder a posse, e não reproduziu',
          { escritaDoZumbi, estadoFinal },
        );
      }
      return ok(Object.freeze({
        defeitoReproduzido: true,
        escritaDoZumbiAceita: true,
        estadoFinal: estadoFinal.estado,
        segundaVendaAberta: segunda.tentativa_id,
      }));
    }

    // ---- Com fencing: a escrita do zumbi TEM de ser recusada. ----
    if (escritaDoZumbi.ok) {
      return err(
        'FencingZumbiEscreveu',
        'O executor anterior conseguiu concluir a tentativa depois de perder a posse',
        { escritaDoZumbi, estadoFinal },
      );
    }
    if (escritaDoZumbi.code !== '55P03') {
      return err(
        'FencingCodigoErrado',
        `A recusa deveria ser 55P03 (tomada por outro executor); veio ${String(escritaDoZumbi.code)}`,
        { escritaDoZumbi },
      );
    }
    if (estadoFinal.estado !== 'falhou' || estadoFinal.bling_pedido_id !== null) {
      return err(
        'FencingEstadoCorrompido',
        'O estado final deveria ser o que a reconciliação gravou, sem nada do executor cercado',
        { estadoFinal },
      );
    }

    return ok(Object.freeze({
      epocaDoOriginal,
      epocaDepoisDaTomada: epocaDaReconciliacao,
      escritaDoZumbiRecusadaCom: escritaDoZumbi.code,
      estadoFinal: estadoFinal.estado,
      segundaVendaAberta: segunda.tentativa_id,
    }));
  } catch (cause) {
    return err('FencingRehearsalFailed', 'Falha inesperada no rehearsal de fencing', {}, cause);
  } finally {
    try {
      await client.end();
    } catch {
      // Encerramento de conexão de teste; nada a fazer se já caiu.
    }
  }
}
