import { NextRequest, NextResponse } from 'next/server';
import { produtoRepository } from '@/repositories/produtoRepository';
import { clienteRepository } from '@/repositories/clienteRepository';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { bling, extractBlingImageUrl } from '@/services/bling';
import { Produto, Cliente, Pedido, ItemPedido } from '@/types';
import { supabaseServer } from '@/lib/supabaseServer';
import { mapBlingStatus, normalizeToE164 } from '@/lib/utils';
import { authorizeSignedServiceTenant } from '@/lib/auth';

export async function GET(req: NextRequest) {
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
      console.warn('⚠️ Webhook Bling: Assinatura ausente (X-Bling-Signature-256). Payload ignorado.');
      return NextResponse.json({ success: false, error: 'Assinatura ausente' }, { status: 403 });
    }

    let integracoes: any[] = [];
    if (userIdHint) {
      const { data } = await supabaseServer.from('integracoes_bling').select('user_id, client_secret').eq('user_id', userIdHint).maybeSingle();
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
    const blingClient = bling.forUser(tenant);

    let body: any;
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

    console.log('📦 Webhook Bling recebido:', JSON.stringify(body, null, 2));

    const events = Array.isArray(body) ? body : [body];
    let processedProducts = 0;

    for (const event of events) {
      const entity = (event.event || event.entity || event.entidade || event.topic || event.type || '').toLowerCase();
      const eventData = event.data || event.retorno || event;

      // 1. Tratar evento de contatos (clientes)
      if (entity.includes('contact') || entity.includes('contato')) {
        const contatoData = eventData.contato || eventData;
        const blingId = String(contatoData.id || contatoData.bling_id || '');

        if (blingId) {
          let fullContact = contatoData;
          if (!fullContact.nome) {
             const fetched = await blingClient.getClientes(1, 1); // Not ideal, no direct getContato in bling.ts yet. Better to rely on event data or ignore partial
             // In Bling v3 webhook, eventData usually contains the payload. 
          }
          const tel = fullContact.telefone || fullContact.celular || undefined;
          const cliente: Cliente = {
            bling_id: blingId,
            nome: fullContact.nome || `Cliente #${blingId}`,
            cpf_cnpj: fullContact.cnpj || fullContact.numeroDocumento || undefined,
            email: fullContact.email || undefined,
            telefone: tel,
            telefone_normalizado: normalizeToE164(tel) || undefined,
          };
          await clienteRepository.upsert(tenant, cliente);
          console.log(`✅ Webhook Bling: Contato ${cliente.nome} (Bling ID: ${blingId}) salvo no Supabase.`);
        }
        continue;
      }

      // 2. Tratar evento de pedidos
      if (entity.includes('order') || entity.includes('pedido')) {
        const pedidoData = eventData.pedido || eventData;
        const blingId = String(pedidoData.id || pedidoData.bling_id || '');
        
        if (blingId) {
          try {
            // Fetch the full order from Bling to get reliable items and status
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
                console.log(`✅ Webhook Bling: Pedido ${pedido.numero} (Bling ID: ${blingId}) atualizado no Supabase.`);
              } else {
                 console.warn(`⚠️ Webhook Bling: Pedido ${fullPedido.numero} ignorado pois o cliente não existe localmente.`);
              }
            }
          } catch (e: any) {
            console.warn(`⚠️ Webhook Bling: Erro ao processar pedido ${blingId}:`, e.message);
          }
        }
        continue;
      }

      // 3. Tratar evento de produtos ou estoque
      if (
        entity.includes('product') || 
        entity.includes('produto') || 
        entity.includes('stock') || 
        entity.includes('estoque')
      ) {
        const prodData = eventData.produto || eventData;
        const blingId = String(prodData.id || prodData.idProduto || prodData.bling_id || '');

        if (!blingId) {
          console.warn('⚠️ Webhook Bling: Evento recebido sem ID de produto válido.');
          continue;
        }

        // Tentar obter dados completos do produto se o webhook enviou apenas dados parciais
        let fullProduct: any = prodData;
        if (!prodData.nome || prodData.preco === undefined || !extractBlingImageUrl(prodData)) {
          try {
            const fetched = await blingClient.getProduto(blingId);
            if (fetched) {
              fullProduct = { ...prodData, ...fetched };
            }
          } catch (e: any) {
            console.warn(`⚠️ Webhook Bling: Não foi possível buscar detalhes estendidos do produto ${blingId}:`, e.message);
          }
        }

        const existingLocal = await produtoRepository.getByBlingId(tenant, blingId);
        const imgUrl = extractBlingImageUrl(fullProduct) || existingLocal?.imagem_url;

        let saldoEstoque = 0;
        if (fullProduct.estoque?.saldoFisico !== undefined) {
          saldoEstoque = Number(fullProduct.estoque.saldoFisico);
        } else if (fullProduct.saldoFisico !== undefined) {
          saldoEstoque = Number(fullProduct.saldoFisico);
        } else if (fullProduct.estoque !== undefined && typeof fullProduct.estoque === 'number') {
          saldoEstoque = Number(fullProduct.estoque);
        } else if (existingLocal) {
          saldoEstoque = existingLocal.estoque;
        }

        const produto: Produto = {
          bling_id: blingId,
          codigo: fullProduct.codigo || existingLocal?.codigo || undefined,
          nome: fullProduct.nome || existingLocal?.nome || `Produto Bling #${blingId}`,
          preco: fullProduct.preco !== undefined ? Number(fullProduct.preco) : (existingLocal?.preco || 0),
          imagem_url: imgUrl || undefined,
          estoque: Math.max(0, saldoEstoque),
        };

        await produtoRepository.upsert(tenant, produto);
        processedProducts++;
        console.log(`✅ Webhook Bling: Produto ${produto.nome} (Bling ID: ${blingId}) salvo no Supabase com sucesso.`);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Webhook processado com sucesso. ${processedProducts} produto(s) atualizado(s).`,
      processedProducts,
    });
  } catch (error: any) {
    console.error('❌ Erro ao processar webhook do Bling:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro ao processar webhook' },
      { status: 500 }
    );
  }
}
