import { NextRequest, NextResponse } from 'next/server';
import { produtoRepository } from '../../../../repositories/produtoRepository';
import { clienteRepository } from '../../../../repositories/clienteRepository';
import { pedidoRepository } from '../../../../repositories/pedidoRepository';
import { imagemDoBling, imagemUrlParaGravar, midiaCompleta } from '../../../../services/imagemDoBling';
import { registrarSeDivergente } from '../../../../services/espelhoDaImagemDoBling';
import type { BlingPort } from '../../../../services/blingPort';
import { Produto, Cliente, Pedido, ItemPedido } from '../../../../types';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { descreverErro } from '../../../../lib/erroLegivel';
import { mapBlingStatus, normalizeToE164 } from '../../../../lib/utils';
import { authorizeWebhookTenant } from './autorizacao';
import { blingInboxService, generateBlingIdempotencyKey } from '../../../../services/blingInboxService';
import type { VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook do Bling ERP ativo e pronto para receber notificações de produtos, estoque e pedidos.',
    timestamp: new Date().toISOString(),
  });
}

/** Interpreta o corpo bruto do webhook (JSON ou form-urlencoded) para a lista de eventos recebidos. */
function parseWebhookEvents(rawBody: string, contentType: string): unknown[] {
  let body: unknown;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawBody);
    const dataStr = params.get('data') || params.get('payload');
    if (typeof dataStr === 'string') {
      body = JSON.parse(dataStr);
    } else {
      body = Object.fromEntries(params.entries());
    }
  } else {
    body = JSON.parse(rawBody || '{}');
  }

  return Array.isArray(body) ? body : [body];
}

/** Sincroniza um evento de contato/cliente recebido do webhook. */
async function processContatoEvent(
  eventData: Record<string, unknown>,
  organizationScope: VerifiedOrganizationScope,
): Promise<string> {
  const contatoData = (eventData.contato || eventData) as Record<string, unknown>;
  const blingId = String(contatoData.id || contatoData.bling_id || '');

  if (blingId) {
    const tel = (contatoData.telefone || contatoData.celular) as string | undefined;
    const cliente: Cliente = {
      bling_id: blingId,
      nome: (contatoData.nome as string) || `Cliente #${blingId}`,
      cpf_cnpj: (contatoData.cnpj || contatoData.numeroDocumento) as string | undefined,
      email: contatoData.email as string | undefined,
      telefone: tel,
      telefone_normalizado: normalizeToE164(tel) || undefined,
    };
    await clienteRepository.upsert(organizationScope, cliente);
  }

  return blingId;
}

/** Monta os itens locais de um pedido do Bling a partir dos itens remotos, ignorando produtos ainda não sincronizados. */
async function buildPedidoItemsParaSalvar(
  itensRemotos: Array<{ produto?: { id?: string | number }; quantidade: number; valor?: number }>,
  pedidoLocalId: string,
  organizationScope: VerifiedOrganizationScope,
): Promise<ItemPedido[]> {
  const itemsParaSalvar: ItemPedido[] = [];
  for (const item of itensRemotos) {
    if (!item.produto?.id) continue;
    const produtoLocal = await produtoRepository.getByBlingId(organizationScope, String(item.produto.id));
    if (!produtoLocal?.id) continue;
    itemsParaSalvar.push({
      pedido_id: pedidoLocalId,
      produto_id: produtoLocal.id,
      quantidade: item.quantidade,
      valor_unitario: Number(item.valor ?? 0),
    });
  }
  return itemsParaSalvar;
}

/** Extrai o `bling_id` do pedido das formas em que o evento pode trazê-lo. */
function resolvePedidoBlingId(eventData: Record<string, unknown>): string {
  const pedidoData = (eventData.pedido || eventData) as Record<string, unknown>;
  return String(pedidoData.id || pedidoData.bling_id || '');
}

/**
 * Reconhece um evento de exclusão pelo nome (`recurso.acao`, ex. `order.deleted`).
 *
 * Precisa ser conferido antes do caminho de criação/atualização: `order.deleted`
 * também contém `order`, e aquele caminho pediria ao Bling um pedido já apagado,
 * não o encontraria e deixaria o pedido local sem nenhum sinal da divergência.
 */
function isDeletionEvent(entity: string): boolean {
  return entity.includes('delet') || entity.includes('exclu') || entity.includes('remov');
}

/**
 * Aplica no ORBITA uma exclusão de pedido feita no Bling: o pedido local é
 * marcado `Cancelado`, não apagado (decisão de produto: preservar o histórico).
 *
 * @returns O `bling_id` do pedido tratado, ou string vazia se o evento não o traz.
 */
async function processPedidoExclusaoEvent(
  eventData: Record<string, unknown>,
  organizationScope: VerifiedOrganizationScope,
): Promise<{ blingId: string; cancelled: boolean }> {
  const blingId = resolvePedidoBlingId(eventData);
  if (!blingId) return { blingId, cancelled: false };

  const cancelled = await pedidoRepository.markCancelledByBlingId(organizationScope, blingId);
  if (!cancelled) {
    console.warn(`⚠️ Webhook Bling: exclusão do pedido ${blingId} recebida, mas ele não existe no ORBITA.`);
  }
  return { blingId, cancelled };
}

/**
 * Sincroniza um evento de pedido de venda recebido do webhook.
 *
 * **A outra ponta da corrida com a venda manual.** Quando o pedido nasceu de uma
 * venda manual do próprio ORBITA, este evento costuma chegar em menos de um
 * segundo e a linha gravada aqui pode ser a **primeira** — a venda manual chega depois e
 * **assume** esta linha (`registrar_venda_manual`, migration 57), em vez de
 * bater em `uq_pedidos_org_bling`.
 *
 * Duas consequências que valem para o leitor daqui:
 *
 * 1. `pedido` não carrega `origem`, `forma_pagamento`, `observacao`, `desconto`
 *    nem `frete`. Não é omissão: é o que impede um evento que chegue **depois**
 *    de apagar a identidade de uma venda manual já registrada. Acrescentar
 *    qualquer um desses campos aqui reabre isso.
 * 2. `buildPedidoItemsParaSalvar` pula o item cujo produto não existe
 *    localmente, então esta rota grava apenas itens de produtos já
 *    cadastrados no ORBITA. A tomada do lado da venda manual conta com isso.
 */
async function processPedidoEvent(
  eventData: Record<string, unknown>,
  blingClient: BlingPort,
  organizationScope: VerifiedOrganizationScope,
): Promise<string> {
  const blingId = resolvePedidoBlingId(eventData);
  if (!blingId) return blingId;

  const fullPedido = await blingClient.getPedido(blingId);
  if (!fullPedido || !fullPedido.contato?.id) return blingId;

  const clienteLocal = await clienteRepository.getByBlingId(organizationScope, String(fullPedido.contato.id));
  if (!clienteLocal?.id) {
    console.warn(`⚠️ Webhook Bling: Pedido ${fullPedido.numero} ignorado pois o cliente não existe localmente.`);
    return blingId;
  }

  const pedido: Pedido = {
    bling_id: String(fullPedido.id),
    numero: String(fullPedido.numero),
    data: fullPedido.data,
    total: Number(fullPedido.total),
    status: mapBlingStatus(fullPedido.situacao.valor),
    cliente_id: clienteLocal.id,
  };
  const savedPedido = await pedidoRepository.upsert(organizationScope, pedido);
  if (!savedPedido.id) return blingId;

  const itemsParaSalvar = await buildPedidoItemsParaSalvar(fullPedido.itens ?? [], savedPedido.id, organizationScope);
  if (itemsParaSalvar.length > 0) {
    await pedidoRepository.addItems(organizationScope, itemsParaSalvar);
  }

  return blingId;
}

/** Resolve o saldo de estoque local a partir das diferentes formas em que o Bling pode reportá-lo. */
function resolveSaldoEstoque(fullProduct: Record<string, unknown>, existingLocal: Produto | null): number {
  const estoqueObj = fullProduct.estoque as Record<string, unknown> | number | undefined;
  if (estoqueObj && typeof estoqueObj === 'object' && estoqueObj.saldoFisico !== undefined) {
    return Number(estoqueObj.saldoFisico);
  }
  if (fullProduct.saldoFisico !== undefined) {
    return Number(fullProduct.saldoFisico);
  }
  if (typeof estoqueObj === 'number') {
    return estoqueObj;
  }
  return existingLocal?.estoque ?? 0;
}

/**
 * O produto do evento, completo quando possível, e se a leitura é autoritativa
 * sobre mídia (`midiaCompleta`). Payload sem o bloco de mídia → busca o
 * detalhe; se a busca falhar, a imagem fica desconhecida e o espelho local não muda.
 */
async function fetchFullProdutoIfIncomplete(
  prodData: Record<string, unknown>,
  blingId: string,
  blingClient: BlingPort,
): Promise<{ readonly dados: Record<string, unknown>; readonly autoritativo: boolean; readonly leituraAtual: boolean }> {
  const isComplete = prodData.nome !== undefined && prodData.preco !== undefined && midiaCompleta(prodData);
  if (isComplete) return { dados: prodData, autoritativo: true, leituraAtual: false };

  try {
    const fetched = await blingClient.getProduto(blingId);
    if (fetched) return { dados: { ...prodData, ...fetched }, autoritativo: midiaCompleta(fetched), leituraAtual: true };
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : 'Erro ao buscar produto';
    console.warn(`⚠️ Webhook Bling: Não foi possível buscar detalhes estendidos do produto ${blingId}:`, errMsg);
  }
  return { dados: prodData, autoritativo: midiaCompleta(prodData), leituraAtual: false };
}

/** Sincroniza um evento de produto/estoque recebido do webhook. Retorna `true` quando um produto foi persistido. */
async function processProdutoEvent(
  eventData: Record<string, unknown>,
  blingClient: BlingPort,
  organizationScope: VerifiedOrganizationScope,
): Promise<{ blingId: string; processed: boolean; ignoredReason?: string }> {
  const prodData = (eventData.produto || eventData) as Record<string, unknown>;
  const blingId = String(prodData.id || prodData.idProduto || prodData.bling_id || '');

  if (!blingId) {
    console.warn('⚠️ Webhook Bling: Evento recebido sem ID de produto válido.');
    return { blingId, processed: false, ignoredReason: 'missing_id' };
  }

  const { dados: fullProduct, autoritativo, leituraAtual } = await fetchFullProdutoIfIncomplete(prodData, blingId, blingClient);
  const existingLocal = await produtoRepository.getByBlingId(organizationScope, blingId);
  // Tri-estado: imagem confirmada → URL; leitura completa sem imagem → null; desconhecida → a local.
  const imagem = imagemDoBling(fullProduct, { autoritativo });
  const imgUrl = imagemUrlParaGravar(imagem, existingLocal?.imagem_url);
  const saldoEstoque = resolveSaldoEstoque(fullProduct, existingLocal);

  const produto: Produto = {
    bling_id: blingId,
    codigo: (fullProduct.codigo as string) || existingLocal?.codigo || undefined,
    nome: (fullProduct.nome as string) || existingLocal?.nome || `Produto Bling #${blingId}`,
    preco: fullProduct.preco !== undefined ? Number(fullProduct.preco) : (existingLocal?.preco || 0),
    imagem_url: imgUrl,
    estoque: Math.max(0, saldoEstoque),
  };

  await produtoRepository.upsert(organizationScope, produto);
  // Leitura atual com imagem num produto que o ORBITA gerencia sem foto = drift.
  await registrarSeDivergente(organizationScope, blingId, imagem, leituraAtual);
  return { blingId, processed: true };
}

/**
 * Desfecho de um evento. `Falhou` existe porque o número sozinho não bastaria:
 * um evento que estourasse devolvendo `0` seria indistinguível de um evento que
 * não atualizou produto nenhum, e a rota responderia sucesso.
 */
type ResultadoEvento =
  | { readonly _tag: 'Concluido'; readonly produtosAtualizados: number }
  | { readonly _tag: 'Falhou'; readonly idempotencyKey: string; readonly causa: string };

/** Processa um único evento do webhook, registrando-o no inbox idempotente antes e depois. */
async function processWebhookEvent(
  event: unknown,
  blingClient: BlingPort,
  organizationScope: VerifiedOrganizationScope,
  conexaoId: string | null,
): Promise<ResultadoEvento> {
  const eventRecord = (event && typeof event === 'object') ? (event as Record<string, unknown>) : {};
  const entity = String(eventRecord.event || eventRecord.entity || eventRecord.entidade || eventRecord.topic || eventRecord.type || '').toLowerCase();
  const eventData = (eventRecord.data || eventRecord.retorno || eventRecord) as Record<string, unknown>;
  const idempotencyKey = generateBlingIdempotencyKey(event);

  const inboxResult = await blingInboxService.registerEvent(supabaseServer, organizationScope, {
    conexaoId,
    idempotencyKey,
    eventType: entity || 'desconhecido',
    payload: event,
  });

  // Só `processed` é curto-circuitado. Um evento `failed` reentregue **é**
  // reprocessado — é exatamente assim que a recuperação acontece, sem
  // consumidor de replay nenhum: a nova tentativa do Bling é o replay.
  if (inboxResult.isDuplicate && inboxResult.status === 'processed') {
    const cache = typeof inboxResult.cachedResponse?.processedProducts === 'number'
      ? inboxResult.cachedResponse.processedProducts
      : 0;
    return { _tag: 'Concluido', produtosAtualizados: cache };
  }

  try {
    if (entity.includes('contact') || entity.includes('contato')) {
      const blingId = await processContatoEvent(eventData, organizationScope);
      await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, entity: 'contato', blingId });
      return { _tag: 'Concluido', produtosAtualizados: 0 };
    }

    if (entity.includes('order') || entity.includes('pedido')) {
      if (isDeletionEvent(entity)) {
        const exclusao = await processPedidoExclusaoEvent(eventData, organizationScope);
        await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, {
          success: true,
          entity: 'pedido',
          acao: 'cancelado',
          blingId: exclusao.blingId,
          cancelado: exclusao.cancelled,
        });
        return { _tag: 'Concluido', produtosAtualizados: 0 };
      }

      const blingId = await processPedidoEvent(eventData, blingClient, organizationScope);
      await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, entity: 'pedido', blingId });
      return { _tag: 'Concluido', produtosAtualizados: 0 };
    }

    if (entity.includes('product') || entity.includes('produto') || entity.includes('stock') || entity.includes('estoque')) {
      const result = await processProdutoEvent(eventData, blingClient, organizationScope);
      if (!result.processed) {
        await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, ignored: true, reason: result.ignoredReason });
        return { _tag: 'Concluido', produtosAtualizados: 0 };
      }
      await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, {
        success: true,
        entity: 'produto',
        blingId: result.blingId,
        processedProducts: 1,
      });
      return { _tag: 'Concluido', produtosAtualizados: 1 };
    }

    return { _tag: 'Concluido', produtosAtualizados: 0 };
  } catch (err: unknown) {
    await blingInboxService.markFailed(supabaseServer, organizationScope, inboxResult.eventoId, err);
    const causa = descreverErro(err);
    console.error(`❌ Erro ao processar evento do webhook Bling (Key: ${idempotencyKey}):`, causa);
    return { _tag: 'Falhou', idempotencyKey, causa };
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-bling-signature-256');

    const authorization = await authorizeWebhookTenant(rawBody, signatureHeader);
    if (authorization._tag === 'Denied') return authorization.response;
    const { blingClient, organizationScope, conexaoId } = authorization;

    const events = parseWebhookEvents(rawBody, req.headers.get('content-type') || '');

    let processedProducts = 0;
    const falhas: Array<{ idempotencyKey: string; causa: string }> = [];
    for (const event of events) {
      const resultado = await processWebhookEvent(event, blingClient, organizationScope, conexaoId);
      if (resultado._tag === 'Falhou') falhas.push(resultado);
      else processedProducts += resultado.produtosAtualizados;
    }

    if (falhas.length > 0) {
      // Não responde 2xx: o evento ficaria `failed` no inbox, o Bling o
      // consideraria entregue e ninguém o reprocessaria — não há consumidor
      // automático de replay. A documentação do Bling prevê nova tentativa
      // para resposta diferente de 2xx, e é essa nova tentativa que reprocessa
      // o evento `failed`. Os eventos que deram certo no mesmo lote voltam como
      // duplicados já `processed` e são ignorados pelo inbox.
      console.error(`❌ Webhook Bling: ${falhas.length} evento(s) falharam e serão reentregues.`);
      return NextResponse.json(
        {
          success: false,
          error: `${falhas.length} evento(s) não puderam ser processados; aguardando reentrega.`,
          eventosComFalha: falhas.map((f) => f.idempotencyKey),
          processedProducts,
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      success: true,
      message: `Webhook processado com sucesso. ${processedProducts} produto(s) atualizado(s).`,
      processedProducts,
    });
  } catch (error: unknown) {
    const message = descreverErro(error);
    console.error('❌ Erro ao processar webhook do Bling:', error);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
