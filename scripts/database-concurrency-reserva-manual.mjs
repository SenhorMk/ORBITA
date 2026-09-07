import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

/**
 * Ticket 30 — a regressão que a jornada real no staging revelou, provada
 * contra o schema COMPLETO.
 *
 * ## O que o pgTAP não alcança
 *
 * `supabase/tests/database/reserva_venda_manual.test.sql` prova a aritmética
 * dos dois gatilhos de reserva num schema mínimo. Ele não exercita
 * `registrar_venda_manual_com_posse` nem — e este é o ponto — o gatilho
 * `tg_validar_estoque_disponivel` (CT-008), que roda BEFORE INSERT OR UPDATE
 * em `itens_pedido` e recusa a gravação quando a disponibilidade ficaria
 * negativa.
 *
 * É essa combinação que explica o evento real: a venda manual baixou o
 * estoque, o webhook devolveu o pedido para `Pendente` e a reserva
 * ressuscitou, deixando `estoque=1 / reservado=1`. Com a disponibilidade em
 * zero, o `addItems` do próprio webhook passa a operar na borda do CT-008 —
 * e o inbox registrou `failed` sem conseguir dizer por quê.
 *
 * Este rehearsal encena as DUAS ordens da corrida contra o banco de verdade e
 * verifica o invariante do ticket: **1 unidade vendida derruba a
 * disponibilidade em exatamente 1, e o webhook completa sem exceção.**
 *
 * - **`esperado: 'sem-correcao'`** — reintroduz os corpos da migration 58 por
 *   cima dos da 60 e reproduz o defeito.
 * - **`esperado: 'com-correcao'`** — prova a correção.
 */

const ORG_ID = 'a1000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a1000000-0000-4000-8000-000000000002';
const CLIENTE_ID = 'a1000000-0000-4000-8000-000000000003';
const PRODUTO_A = 'a1000000-0000-4000-8000-00000000000a';
const PRODUTO_B = 'a1000000-0000-4000-8000-00000000000b';
const BLING_A = '26801269702';
const BLING_B = '26801269703';
const ESTOQUE_INICIAL = 2;

async function seed(client) {
  await client.query(
    `insert into auth.users (id, email) values ($1, 'owner-reserva-t30@orbita.test') on conflict (id) do nothing`,
    [OWNER_ID],
  );
  await client.query(
    `insert into public.organizacoes (id, nome, slug) values ($1, 'Org Reserva T30', 'org-reserva-t30')
     on conflict (id) do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')
     on conflict (organizacao_id, user_id) do nothing`,
    [ORG_ID, OWNER_ID],
  );
  await client.query(
    `insert into public.clientes (id, user_id, organizacao_id, bling_id, nome)
     values ($1, $2, $3, '321', 'Cliente Reserva') on conflict (id) do nothing`,
    [CLIENTE_ID, OWNER_ID, ORG_ID],
  );
  for (const [id, nome, blingId] of [[PRODUTO_A, 'Rapé A', '901'], [PRODUTO_B, 'Rapé B', '902']]) {
    await client.query(
      `insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque, estoque_reservado)
       values ($1, $2, $3, $4, $5, 40.00, $6, 0) on conflict (id) do nothing`,
      [id, OWNER_ID, ORG_ID, blingId, nome, ESTOQUE_INICIAL],
    );
  }
}

/** O estado que o invariante mede. */
async function disponibilidade(client, produtoId) {
  const { rows } = await client.query(
    `select estoque, estoque_reservado, (estoque - estoque_reservado) as disponivel
       from public.produtos where id = $1`,
    [produtoId],
  );
  return rows[0];
}

/** A venda manual real: reivindica a tentativa e grava venda + ledger juntos. */
async function venderManualmente(client, referencia, blingPedidoId, produtoId) {
  const { rows } = await client.query(
    `select * from public.reivindicar_tentativa_venda_manual($1, $2, $3, $4)`,
    [ORG_ID, referencia, `fingerprint-${referencia}`, `valores-${referencia}`],
  );
  const tentativa = rows[0];
  const itens = JSON.stringify([{ produto_id: produtoId, quantidade: 1, valor_unitario: 40.0 }]);
  await client.query(
    `select public.registrar_venda_manual_com_posse($1,$2,$3,$4,$4,40.00,0,0,'Dinheiro',null,current_date,$5::jsonb,$6,$7)`,
    [ORG_ID, OWNER_ID, CLIENTE_ID, blingPedidoId, itens, tentativa.tentativa_id, tentativa.epoca],
  );
  return tentativa;
}

/**
 * O webhook, exatamente como `processPedidoEvent` o executa: `upsert` do
 * pedido com a situação que veio do Bling e, em seguida, `addItems`.
 */
async function sincronizarWebhook(client, blingPedidoId, produtoId, numero) {
  const { rows } = await client.query(
    `insert into public.pedidos (user_id, organizacao_id, cliente_id, bling_id, numero, data, total, status, origem)
     values ($1,$2,$3,$4,$5,current_date,40.00,'Pendente','Bling')
     on conflict (organizacao_id, bling_id) do update
        set status = excluded.status, numero = excluded.numero, total = excluded.total
     returning id`,
    [OWNER_ID, ORG_ID, CLIENTE_ID, blingPedidoId, numero],
  );
  const pedidoId = rows[0].id;
  await client.query(
    `insert into public.itens_pedido (user_id, organizacao_id, pedido_id, produto_id, quantidade, valor_unitario)
     values ($1,$2,$3,$4,1,40.00)
     on conflict (pedido_id, produto_id) do update set quantidade = excluded.quantidade`,
    [OWNER_ID, ORG_ID, pedidoId, produtoId],
  );
  return pedidoId;
}

async function tentar(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (cause) {
    return { ok: false, code: cause?.code, message: cause?.message };
  }
}

/**
 * @param {object} [options] - Fábrica de cliente e expectativa.
 * @param {'com-correcao' | 'sem-correcao'} [options.esperado] - O que se espera observar.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runReservaManualRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-reserva'),
  esperado = 'com-correcao',
} = {}) {
  const client = createClient();
  try {
    await client.connect();
    await seed(client);

    if (esperado === 'sem-correcao') {
      // Reintroduz o defeito: os corpos da 58 por cima dos da 60.
      const caminho = path.resolve('database', '58_reserva_nao_conta_pedido_finalizado.sql');
      await client.query(readFileSync(caminho, 'utf8').replace(/^﻿/, ''));
    }

    // ---- ORDEM 1: venda manual conclui, webhook chega depois. ----
    await venderManualmente(client, 'ORBITA-reserva-ordem-1', BLING_A, PRODUTO_A);
    const aposVenda = await disponibilidade(client, PRODUTO_A);

    const webhook = await tentar(() => sincronizarWebhook(client, BLING_A, PRODUTO_A, '21'));
    const aposWebhook = await disponibilidade(client, PRODUTO_A);

    if (esperado === 'sem-correcao') {
      if (Number(aposWebhook.disponivel) !== 0) {
        return err(
          'ReservaDefeitoNaoReproduzido',
          'Esperava reproduzir a disponibilidade caindo 2 por uma venda de 1, e não reproduziu',
          { aposVenda, aposWebhook },
        );
      }
      return ok(Object.freeze({
        defeitoReproduzido: true,
        disponibilidadeAposVenda: Number(aposVenda.disponivel),
        disponibilidadeAposWebhook: Number(aposWebhook.disponivel),
        webhookOk: webhook.ok,
        webhookCode: webhook.code ?? null,
      }));
    }

    if (Number(aposVenda.disponivel) !== ESTOQUE_INICIAL - 1) {
      return err('ReservaVendaManualErrada', 'A venda manual não derrubou a disponibilidade em exatamente 1', { aposVenda });
    }
    if (!webhook.ok) {
      return err(
        'ReservaWebhookFalhou',
        'O webhook posterior à venda manual falhou — é o efeito parcial que o inbox registrou como `failed`',
        { webhook, aposWebhook },
      );
    }
    if (Number(aposWebhook.disponivel) !== ESTOQUE_INICIAL - 1 || Number(aposWebhook.estoque_reservado) !== 0) {
      return err(
        'ReservaRessuscitou',
        'O webhook devolveu o pedido para Pendente e a reserva voltou — a mesma unidade contada duas vezes',
        { aposVenda, aposWebhook },
      );
    }

    // ---- ORDEM 2: webhook primeiro, venda manual assume a linha. ----
    await sincronizarWebhook(client, BLING_B, PRODUTO_B, '22');
    const aposWebhookB = await disponibilidade(client, PRODUTO_B);
    if (Number(aposWebhookB.estoque_reservado) !== 1) {
      return err('ReservaWebhookNaoReservou', 'Um pedido do Bling em aberto precisa reservar', { aposWebhookB });
    }

    await venderManualmente(client, 'ORBITA-reserva-ordem-2', BLING_B, PRODUTO_B);
    const aposTomada = await disponibilidade(client, PRODUTO_B);
    if (Number(aposTomada.estoque_reservado) !== 0) {
      return err(
        'ReservaFantasmaPresa',
        'A tomada da linha pela venda manual precisa LIBERAR a reserva que o webhook criou',
        { aposWebhookB, aposTomada },
      );
    }
    if (Number(aposTomada.disponivel) !== ESTOQUE_INICIAL - 1) {
      return err('ReservaTomadaErrada', 'Na ordem webhook-primeiro a disponibilidade também tem de cair exatamente 1', { aposTomada });
    }

    return ok(Object.freeze({
      ordem1DisponibilidadeFinal: Number(aposWebhook.disponivel),
      ordem1ReservaFinal: Number(aposWebhook.estoque_reservado),
      ordem1WebhookOk: webhook.ok,
      ordem2ReservaDoWebhook: Number(aposWebhookB.estoque_reservado),
      ordem2ReservaAposTomada: Number(aposTomada.estoque_reservado),
      ordem2DisponibilidadeFinal: Number(aposTomada.disponivel),
    }));
  } catch (cause) {
    return err('ReservaRehearsalFailed', 'Falha inesperada no rehearsal de reserva da venda manual', {}, cause);
  } finally {
    try {
      await client.end();
    } catch {
      // Encerramento de conexão de teste; nada a fazer se já caiu.
    }
  }
}
