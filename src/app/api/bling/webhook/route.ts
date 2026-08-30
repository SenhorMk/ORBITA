import { NextRequest, NextResponse } from 'next/server';
import { produtoRepository } from '../../../../repositories/produtoRepository';
import { clienteRepository } from '../../../../repositories/clienteRepository';
import { pedidoRepository } from '../../../../repositories/pedidoRepository';
import { bling, extractBlingImageUrl } from '../../../../services/bling';
import type { BlingPort } from '../../../../services/blingPort';
import { Produto, Cliente, Pedido, ItemPedido } from '../../../../types';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { mapBlingStatus, normalizeToE164 } from '../../../../lib/utils';
import { authorizeSignedServiceTenant } from '../../../../lib/auth';
import { blingInboxService, generateBlingIdempotencyKey } from '../../../../services/blingInboxService';
import { verifyOrganizationScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook do Bling ERP ativo e pronto para receber notificações de produtos, estoque e pedidos.',
    timestamp: new Date().toISOString(),
  });
}

/** Resultado da resolução de tenant/organização a partir da assinatura HMAC do webhook. */
type WebhookAuthorizationResult =
  | { readonly _tag: 'Authorized'; readonly organizationScope: VerifiedOrganizationScope; readonly conexaoId: string | null; readonly blingClient: BlingPort }
  | { readonly _tag: 'Denied'; readonly response: NextResponse };

/**
 * Valida a assinatura HMAC do webhook contra os secrets de todos os tenants
 * candidatos e resolve, de forma inequívoca, a organização associada.
 * Nunca atribui ao "primeiro" resultado ambíguo: se a organização não puder
 * ser resolvida sem ambiguidade, falha fechado.
 */
async function authorizeWebhookTenant(
  rawBody: string,
  signatureHeader: string | null,
  userIdHint: string | null,
): Promise<WebhookAuthorizationResult> {
  if (!signatureHeader) {
    console.warn('⚠️ Webhook Bling: Assinatura ausente. Payload ignorado.');
    return { _tag: 'Denied', response: NextResponse.json({ success: false, error: 'Assinatura ausente' }, { status: 403 }) };
  }

  let integracoes: Array<{ user_id: string; client_secret: string }> = [];
  if (userIdHint) {
    const { data } = await supabaseServer
      .from('integracoes_bling')
      .select('user_id, client_secret')
      .eq('user_id', userIdHint)
      .maybeSingle();
    if (data) integracoes = [data];
  }

  if (integracoes.length === 0) {
    const { data } = await supabaseServer.from('integracoes_bling').select('user_id, client_secret');
    if (data) integracoes = data;
  }

  const tenantAuthorization = authorizeSignedServiceTenant(
    rawBody,
    signatureHeader,
    integracoes.map((integration) => ({
      tenantId: integration.user_id,
      encryptedSecret: integration.client_secret,
    })),
  );

  if (tenantAuthorization._tag === 'ServiceTenantDenied') {
    console.warn('⚠️ Webhook Bling: Assinatura inválida (nenhum tenant correspondente). Payload ignorado.');
    return { _tag: 'Denied', response: NextResponse.json({ success: false, error: 'Assinatura inválida' }, { status: 403 }) };
  }

  const tenant = tenantAuthorization.tenant;

  // Resolução de escopo multi-tenant organizacional. `tenant.id` é o
  // user_id legado autenticado pela assinatura HMAC acima (nunca um hint
  // de payload/query não verificado). `conexoes_integracao` não possui
  // coluna `user_id` — o vínculo legado é rastreado em
  // `metadata->>'migrado_de_user_id'` pelo backfill contabilizado
  // (database/46_backfill_bling_conexoes_organizacao_contabilizado.sql).
  let organizacaoId: string | null = null;
  let conexaoId: string | null = null;

  const { data: linkedConn } = await supabaseServer
    .from('conexoes_integracao')
    .select('id, organizacao_id')
    .eq('provedor', 'bling')
    .contains('metadata', { migrado_de_user_id: tenant.id })
    .limit(1)
    .maybeSingle();

  if (linkedConn) {
    organizacaoId = linkedConn.organizacao_id;
    conexaoId = linkedConn.id;
  } else {
    const { data: memberships } = await supabaseServer
      .from('membros_organizacao')
      .select('organizacao_id')
      .eq('user_id', tenant.id);
    const distinctOrgIds = Array.from(new Set((memberships || []).map((m) => m.organizacao_id)));

    if (distinctOrgIds.length === 1) {
      organizacaoId = distinctOrgIds[0];
    } else {
      console.warn(
        `⚠️ Webhook Bling: não foi possível resolver organização inequívoca para o tenant legado (${distinctOrgIds.length} organizações candidatas). Payload rejeitado.`,
      );
      return {
        _tag: 'Denied',
        response: NextResponse.json(
          { success: false, error: 'Organização não pôde ser determinada de forma inequívoca para este evento.' },
          { status: 403 },
        ),
      };
    }
  }

  if (!organizacaoId) {
    // Defesa em profundidade: nunca deveria ser alcançável (os dois ramos
    // acima ou definem organizacaoId ou retornam antes), mas falha fechado
    // em vez de invocar o adapter com um escopo indefinido.
    return { _tag: 'Denied', response: NextResponse.json({ success: false, error: 'Organização não pôde ser determinada.' }, { status: 403 }) };
  }

  const blingClient = bling.forOrganization(organizacaoId, conexaoId || undefined);
  const scopeResult = await verifyOrganizationScope(supabaseServer, {
    organizationId: organizacaoId,
    actorId: tenant.id,
  });
  if (scopeResult._tag !== 'OrganizationScopeVerified') {
    const unavailable = scopeResult._tag === 'OrganizationScopeStoreUnavailable';
    return {
      _tag: 'Denied',
      response: NextResponse.json(
        { success: false, error: unavailable ? 'Serviço de autorização indisponível' : 'Escopo organizacional inválido' },
        { status: unavailable ? 503 : 403 },
      ),
    };
  }

  return { _tag: 'Authorized', organizationScope: scopeResult.scope, conexaoId, blingClient };
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
  itensRemotos: Array<{ produto?: { id?: string | number }; quantidade: number; valorunitario?: number; valor?: number }>,
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
      valor_unitario: Number(item.valorunitario ?? item.valor ?? 0),
    });
  }
  return itemsParaSalvar;
}

/** Sincroniza um evento de pedido de venda recebido do webhook. */
async function processPedidoEvent(
  eventData: Record<string, unknown>,
  blingClient: BlingPort,
  organizationScope: VerifiedOrganizationScope,
): Promise<string> {
  const pedidoData = (eventData.pedido || eventData) as Record<string, unknown>;
  const blingId = String(pedidoData.id || pedidoData.bling_id || '');
  if (!blingId) return blingId;

  const fullPedido = await blingClient.getPedido(blingId);
  if (!fullPedido || !fullPedido.contato?.id) return blingId;

  const clienteLocal = await clienteRepository.getByBlingId(organizationScope, fullPedido.contato.id);
  if (!clienteLocal?.id) {
    console.warn(`⚠️ Webhook Bling: Pedido ${fullPedido.numero} ignorado pois o cliente não existe localmente.`);
    return blingId;
  }

  const pedido: Pedido = {
    bling_id: fullPedido.id,
    numero: fullPedido.numero,
    data: fullPedido.data,
    total: Number(fullPedido.total),
    status: mapBlingStatus(fullPedido.situacao.valor),
    cliente_id: clienteLocal.id,
  };
  const savedPedido = await pedidoRepository.upsert(organizationScope, pedido);
  if (!savedPedido.id) return blingId;

  const itemsParaSalvar = await buildPedidoItemsParaSalvar(fullPedido.itens, savedPedido.id, organizationScope);
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

/** Busca detalhes estendidos do produto no Bling quando o payload do evento veio incompleto. */
async function fetchFullProdutoIfIncomplete(
  prodData: Record<string, unknown>,
  blingId: string,
  blingClient: BlingPort,
): Promise<Record<string, unknown>> {
  const isComplete = prodData.nome !== undefined && prodData.preco !== undefined && Boolean(extractBlingImageUrl(prodData));
  if (isComplete) return prodData;

  try {
    const fetched = await blingClient.getProduto(blingId);
    return fetched ? { ...prodData, ...fetched } : prodData;
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : 'Erro ao buscar produto';
    console.warn(`⚠️ Webhook Bling: Não foi possível buscar detalhes estendidos do produto ${blingId}:`, errMsg);
    return prodData;
  }
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

  const fullProduct = await fetchFullProdutoIfIncomplete(prodData, blingId, blingClient);
  const existingLocal = await produtoRepository.getByBlingId(organizationScope, blingId);
  const imgUrl = extractBlingImageUrl(fullProduct) || existingLocal?.imagem_url;
  const saldoEstoque = resolveSaldoEstoque(fullProduct, existingLocal);

  const produto: Produto = {
    bling_id: blingId,
    codigo: (fullProduct.codigo as string) || existingLocal?.codigo || undefined,
    nome: (fullProduct.nome as string) || existingLocal?.nome || `Produto Bling #${blingId}`,
    preco: fullProduct.preco !== undefined ? Number(fullProduct.preco) : (existingLocal?.preco || 0),
    imagem_url: imgUrl || undefined,
    estoque: Math.max(0, saldoEstoque),
  };

  await produtoRepository.upsert(organizationScope, produto);
  return { blingId, processed: true };
}

/** Processa um único evento do webhook, registrando-o no inbox idempotente antes e depois. */
async function processWebhookEvent(
  event: unknown,
  blingClient: BlingPort,
  organizationScope: VerifiedOrganizationScope,
  conexaoId: string | null,
): Promise<number> {
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

  if (inboxResult.isDuplicate && inboxResult.status === 'processed') {
    return typeof inboxResult.cachedResponse?.processedProducts === 'number' ? inboxResult.cachedResponse.processedProducts : 0;
  }

  try {
    if (entity.includes('contact') || entity.includes('contato')) {
      const blingId = await processContatoEvent(eventData, organizationScope);
      await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, entity: 'contato', blingId });
      return 0;
    }

    if (entity.includes('order') || entity.includes('pedido')) {
      const blingId = await processPedidoEvent(eventData, blingClient, organizationScope);
      await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, entity: 'pedido', blingId });
      return 0;
    }

    if (entity.includes('product') || entity.includes('produto') || entity.includes('stock') || entity.includes('estoque')) {
      const result = await processProdutoEvent(eventData, blingClient, organizationScope);
      if (!result.processed) {
        await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, ignored: true, reason: result.ignoredReason });
        return 0;
      }
      await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, {
        success: true,
        entity: 'produto',
        blingId: result.blingId,
        processedProducts: 1,
      });
      return 1;
    }

    return 0;
  } catch (err: unknown) {
    await blingInboxService.markFailed(supabaseServer, organizationScope, inboxResult.eventoId, err);
    console.error(`❌ Erro ao processar evento do webhook Bling (Key: ${idempotencyKey}):`, err);
    return 0;
  }
}

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const userIdHint = url.searchParams.get('userId');

    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-bling-signature-256');

    const authorization = await authorizeWebhookTenant(rawBody, signatureHeader, userIdHint);
    if (authorization._tag === 'Denied') return authorization.response;
    const { blingClient, organizationScope, conexaoId } = authorization;

    const events = parseWebhookEvents(rawBody, req.headers.get('content-type') || '');

    let processedProducts = 0;
    for (const event of events) {
      processedProducts += await processWebhookEvent(event, blingClient, organizationScope, conexaoId);
    }

    return NextResponse.json({
      success: true,
      message: `Webhook processado com sucesso. ${processedProducts} produto(s) atualizado(s).`,
      processedProducts,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao processar webhook';
    console.error('❌ Erro ao processar webhook do Bling:', error);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
