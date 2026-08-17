import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { produtoRepository } from '@/repositories/produtoRepository';
import { mapBlingStatus } from '@/lib/utils';

export async function POST(request: Request) {
  try {
    const { data: { session }, error: sessionError } = await supabaseServer.auth.getSession();
    
    if (sessionError || !session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const userId = session.user.id;
    const body = await request.json();
    const { pedidoId, novaSituacaoId, novaSituacaoNome } = body;

    if (!pedidoId || !novaSituacaoId || !novaSituacaoNome) {
      return NextResponse.json({ error: 'Dados incompletos (pedidoId, novaSituacaoId, novaSituacaoNome são obrigatórios)' }, { status: 400 });
    }

    // 1. Busca o pedido local
    const pedidoLocal = await pedidoRepository.getById(userId, pedidoId);
    if (!pedidoLocal || !pedidoLocal.bling_id) {
      return NextResponse.json({ error: 'Pedido não encontrado ou sem ID do Bling' }, { status: 404 });
    }

    const blingClient = bling.forUser(userId);

    // 2. Atualiza a situação no Bling
    await blingClient.updateSituacaoPedido(pedidoLocal.bling_id, novaSituacaoId);

    // 3. Atualiza o status localmente no Supabase
    const novoStatusCanonico = mapBlingStatus(novaSituacaoNome);
    await pedidoRepository.upsert(userId, {
      ...pedidoLocal,
      status: novoStatusCanonico
    });

    // 4. Aguarda 2 segundos para o Bling processar as rotinas de estoque e afins (se configurado)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 5. Busca os itens do pedido para atualizar o estoque
    const { data: itens, error: itensError } = await supabaseServer
      .from('itens_pedido')
      .select('produto_id')
      .eq('pedido_id', pedidoId)
      .eq('user_id', userId);

    if (itensError) {
      console.error('Erro ao buscar itens do pedido:', itensError);
      return NextResponse.json({ success: true, warning: 'Status atualizado, mas falhou ao buscar itens para alinhar estoque' });
    }

    if (itens && itens.length > 0) {
      // Pega os IDs locais dos produtos
      const produtosIds = itens.map(i => i.produto_id);
      
      // Busca os bling_ids correspondentes
      const { data: produtosData, error: produtosError } = await supabaseServer
        .from('produtos')
        .select('id, bling_id, estoque')
        .in('id', produtosIds)
        .eq('user_id', userId);

      if (!produtosError && produtosData && produtosData.length > 0) {
        const blingIdsParaSincronizar = produtosData.filter(p => p.bling_id).map(p => p.bling_id!);
        
        if (blingIdsParaSincronizar.length > 0) {
          // Puxa o saldo ATUALIZADO do Bling
          const saldosArray = await blingClient.getEstoquesSaldos(blingIdsParaSincronizar);
          
          const saldosMap = new Map();
          saldosArray.forEach((item: any) => {
            if (item.produto?.id) {
              saldosMap.set(String(item.produto.id), Number(item.saldoFisicoTotal ?? item.saldoFisico ?? 0));
            }
          });

          // Atualiza os produtos no Supabase com o novo estoque
          for (const prod of produtosData) {
            if (prod.bling_id && saldosMap.has(prod.bling_id)) {
              const novoEstoque = saldosMap.get(prod.bling_id);
              if (prod.estoque !== novoEstoque) {
                const { error: updateError } = await supabaseServer
                  .from('produtos')
                  .update({ estoque: novoEstoque })
                  .eq('id', prod.id)
                  .eq('user_id', userId);
                  
                if (updateError) {
                  console.error(`Erro ao atualizar estoque do produto ${prod.id}:`, updateError);
                }
              }
            }
          }
        }
      }
    }

    return NextResponse.json({ success: true, status: novoStatusCanonico });
  } catch (error: any) {
    console.error('Erro ao atualizar status do pedido:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
