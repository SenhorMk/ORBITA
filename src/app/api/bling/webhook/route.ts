import { NextRequest, NextResponse } from 'next/server';
import { produtoRepository } from '../../../../repositories/produtoRepository';
import { clienteRepository } from '../../../../repositories/clienteRepository';
import { pedidoRepository } from '../../../../repositories/pedidoRepository';
import { bling, extractBlingImageUrl } from '../../../../services/bling';
import { Produto, Cliente, Pedido, ItemPedido } from '../../../../types';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { mapBlingStatus, normalizeToE164 } from '../../../../lib/utils';
import { authorizeSignedServiceTenant } from '../../../../lib/auth';
import { blingInboxService, generateBlingIdempotencyKey } from '../../../../services/blingInboxService';
import { verifyOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook do Bling ERP ativo e pronto para receber notificações de produtos, estoque e pedidos.',
    timestamp: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const userIdHint = url.searchParams.get('userId');

    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-bling-signature-256');

    // Validar assinatura HMAC-SHA256 OBRIGATORIAMENTE
    if (!signatureHeader) {
      console.warn('⚠️ Webhook Bling: Assinatura ausente. Payload ignorado.');
      return NextResponse.json({ success: false, error: 'Assinatura ausente' }, { status: 403 });
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
      return NextResponse.json({ success: false, error: 'Assinatura inválida' }, { status: 403 });
    }

    const tenant = tenantAuthorization.tenant;

    // Resolução de escopo multi-tenant organizacional
    let organizacaoId = tenant.id;
    let conexaoId: string | null = null;

    const { data: conn } = await supabaseServer
      .from('conexoes_integracao')
      .select('id, organizacao_id')
      .eq('provedor', 'bling')
      .eq('status', 'conectado')
      .or(`organizacao_id.eq.${tenant.id},user_id.eq.${tenant.id}`)
      .limit(1)
      .maybeSingle();

    if (conn) {
      organizacaoId = conn.organizacao_id;
      conexaoId = conn.id;
    } else {
      const { data: membership } = await supabaseServer
        .from('membros_organizacao')
        .select('organizacao_id')
        .eq('user_id', tenant.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (membership) {
        organizacaoId = membership.organizacao_id;
      }
    }

    const blingClient = bling.forOrganization(organizacaoId, conexaoId || undefined);
    const scopeResult = await verifyOrganizationScope(supabaseServer, {
      organizationId: organizacaoId,
      actorId: tenant.id,
    });
    if (scopeResult._tag !== 'OrganizationScopeVerified') {
      const unavailable = scopeResult._tag === 'OrganizationScopeStoreUnavailable';
      return NextResponse.json(
        { success: false, error: unavailable ? 'Serviço de autorização indisponível' : 'Escopo organizacional inválido' },
        { status: unavailable ? 503 : 403 },
      );
    }
    const organizationScope = scopeResult.scope;

    let body: unknown;
    const contentType = req.headers.get('content-type') || '';

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

    const events = Array.isArray(body) ? body : [body];
    let processedProducts = 0;

    for (const event of events) {
      const eventRecord = (event && typeof event === 'object') ? (event as Record<string, unknown>) : {};
      const entity = String(eventRecord.event || eventRecord.entity || eventRecord.entidade || eventRecord.topic || eventRecord.type || '').toLowerCase();
      const eventData = (eventRecord.data || eventRecord.retorno || eventRecord) as Record<string, unknown>;
      const idempotencyKey = generateBlingIdempotencyKey(event);

      // 1. Registro prévio no inbox idempotente
      const inboxResult = await blingInboxService.registerEvent(supabaseServer, organizationScope, {
        conexaoId,
        idempotencyKey,
        eventType: entity || 'desconhecido',
        payload: event,
      });

      // 2. Duplicata segura: se já processado, retornar resultado sem repetir efeitos colaterais
      if (inboxResult.isDuplicate && inboxResult.status === 'processed') {
        if (inboxResult.cachedResponse && typeof inboxResult.cachedResponse.processedProducts === 'number') {
          processedProducts += inboxResult.cachedResponse.processedProducts;
        }
        continue;
      }

      try {
        // 3. Tratar evento de contatos (clientes)
        if (entity.includes('contact') || entity.includes('contato')) {
          const contatoData = (eventData.contato || eventData) as Record<string, unknown>;
          const blingId = String(contatoData.id || contatoData.bling_id || '');

          if (blingId) {
            const fullContact = contatoData;
            const tel = (fullContact.telefone || fullContact.celular) as string | undefined;
            const cliente: Cliente = {
              bling_id: blingId,
              nome: (fullContact.nome as string) || `Cliente #${blingId}`,
              cpf_cnpj: (fullContact.cnpj || fullContact.numeroDocumento) as string | undefined,
              email: fullContact.email as string | undefined,
              telefone: tel,
              telefone_normalizado: normalizeToE164(tel) || undefined,
            };
            await clienteRepository.upsert(tenant, cliente);
          }
          await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, entity: 'contato', blingId });
          continue;
        }

        // 4. Tratar evento de pedidos
        if (entity.includes('order') || entity.includes('pedido')) {
          const pedidoData = (eventData.pedido || eventData) as Record<string, unknown>;
          const blingId = String(pedidoData.id || pedidoData.bling_id || '');

          if (blingId) {
            const fullPedido = await blingClient.getPedido(blingId);
            if (fullPedido && fullPedido.contato?.id) {
              const clienteLocal = await clienteRepository.getByBlingId(tenant, fullPedido.contato.id);
              if (clienteLocal?.id) {
                const statusCanonico = mapBlingStatus(fullPedido.situacao.valor);
                const pedido: Pedido = {
                  bling_id: fullPedido.id,
                  numero: fullPedido.numero,
                  data: fullPedido.data,
                  total: Number(fullPedido.total),
                  status: statusCanonico,
                  cliente_id: clienteLocal.id,
                };
                const savedPedido = await pedidoRepository.upsert(tenant, pedido);

                const itemsParaSalvar: ItemPedido[] = [];
                for (const item of fullPedido.itens) {
                  if (item.produto?.id) {
                    const produtoLocal = await produtoRepository.getByBlingId(tenant, item.produto.id);
                    if (produtoLocal?.id && savedPedido.id) {
                      itemsParaSalvar.push({
                        pedido_id: savedPedido.id,
                        produto_id: produtoLocal.id,
                        quantidade: item.quantidade,
                        valor_unitario: Number(item.valorunitario ?? item.valor ?? 0),
                      });
                    }
                  }
                }
                if (itemsParaSalvar.length > 0) {
                  await pedidoRepository.addItems(tenant, itemsParaSalvar);
                }
              } else {
                console.warn(`⚠️ Webhook Bling: Pedido ${fullPedido.numero} ignorado pois o cliente não existe localmente.`);
              }
            }
          }
          await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, entity: 'pedido', blingId });
          continue;
        }

        // 5. Tratar evento de produtos ou estoque
        if (
          entity.includes('product') ||
          entity.includes('produto') ||
          entity.includes('stock') ||
          entity.includes('estoque')
        ) {
          const prodData = (eventData.produto || eventData) as Record<string, unknown>;
          const blingId = String(prodData.id || prodData.idProduto || prodData.bling_id || '');

          if (!blingId) {
            console.warn('⚠️ Webhook Bling: Evento recebido sem ID de produto válido.');
            await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, { success: true, ignored: true, reason: 'missing_id' });
            continue;
          }

          let fullProduct: Record<string, unknown> = prodData;
          if (!prodData.nome || prodData.preco === undefined || !extractBlingImageUrl(prodData)) {
            try {
              const fetched = await blingClient.getProduto(blingId);
              if (fetched) {
                fullProduct = { ...prodData, ...fetched };
              }
            } catch (e: unknown) {
              const errMsg = e instanceof Error ? e.message : 'Erro ao buscar produto';
              console.warn(`⚠️ Webhook Bling: Não foi possível buscar detalhes estendidos do produto ${blingId}:`, errMsg);
            }
          }

          const existingLocal = await produtoRepository.getByBlingId(tenant, blingId);
          const imgUrl = extractBlingImageUrl(fullProduct) || existingLocal?.imagem_url;

          let saldoEstoque = 0;
          const estoqueObj = fullProduct.estoque as Record<string, unknown> | number | undefined;
          if (estoqueObj && typeof estoqueObj === 'object' && estoqueObj.saldoFisico !== undefined) {
            saldoEstoque = Number(estoqueObj.saldoFisico);
          } else if (fullProduct.saldoFisico !== undefined) {
            saldoEstoque = Number(fullProduct.saldoFisico);
          } else if (typeof estoqueObj === 'number') {
            saldoEstoque = estoqueObj;
          } else if (existingLocal) {
            saldoEstoque = existingLocal.estoque;
          }

          const produto: Produto = {
            bling_id: blingId,
            codigo: (fullProduct.codigo as string) || existingLocal?.codigo || undefined,
            nome: (fullProduct.nome as string) || existingLocal?.nome || `Produto Bling #${blingId}`,
            preco: fullProduct.preco !== undefined ? Number(fullProduct.preco) : (existingLocal?.preco || 0),
            imagem_url: imgUrl || undefined,
            estoque: Math.max(0, saldoEstoque),
          };

          await produtoRepository.upsert(tenant, produto);
          processedProducts++;
          await blingInboxService.markProcessed(supabaseServer, organizationScope, inboxResult.eventoId, {
            success: true,
            entity: 'produto',
            blingId,
            processedProducts: 1,
          });
        }
      } catch (err: unknown) {
        await blingInboxService.markFailed(supabaseServer, organizationScope, inboxResult.eventoId, err);
        console.error(`❌ Erro ao processar evento do webhook Bling (Key: ${idempotencyKey}):`, err);
      }
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
