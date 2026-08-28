import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { mapBlingStatus } from '@/lib/utils';
import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

type BlingClient = ReturnType<typeof bling.forUser>;

/**
 * Sincroniza o saldo local de estoque dos produtos vinculados a um pedido a
 * partir do Bling. Retorna uma mensagem de aviso quando os itens do pedido
 * não puderam ser consultados (o status do pedido já foi atualizado, então
 * essa falha não é bloqueante — apenas reportada ao chamador).
 */
async function syncEstoqueForPedidoItems(
  scope: VerifiedOrganizationScope,
  blingClient: BlingClient,
  pedidoId: string,
): Promise<string | undefined> {
  const { data: itens, error: itensError } = await supabaseServer
    .from('itens_pedido')
    .select('produto_id')
    .eq('pedido_id', pedidoId)
    .eq('organizacao_id', scope.organizationId);

  if (itensError) {
    console.error('Erro ao buscar itens do pedido:', itensError);
    return 'Status atualizado, mas falhou ao buscar itens para alinhar estoque';
  }
  if (!itens || itens.length === 0) return undefined;

  const produtosIds = itens.map(i => i.produto_id);
  const { data: produtosData, error: produtosError } = await supabaseServer
    .from('produtos')
    .select('id, bling_id, estoque')
    .in('id', produtosIds)
    .eq('organizacao_id', scope.organizationId);

  if (produtosError || !produtosData || produtosData.length === 0) return undefined;

  const blingIdsParaSincronizar = produtosData.filter(p => p.bling_id).map(p => p.bling_id!);
  if (blingIdsParaSincronizar.length === 0) return undefined;

  // Puxa o saldo ATUALIZADO do Bling
  const saldosArray = await blingClient.getEstoquesSaldos(blingIdsParaSincronizar);
  const saldosMap = new Map<string, number>();
  (saldosArray as Array<{ produto?: { id: number | string }; saldoFisicoTotal?: number; saldoFisico?: number }>).forEach((item) => {
    if (item.produto?.id) {
      saldosMap.set(String(item.produto.id), Number(item.saldoFisicoTotal ?? item.saldoFisico ?? 0));
    }
  });

  // Atualiza os produtos no Supabase com o novo estoque
  for (const prod of produtosData) {
    if (!prod.bling_id || !saldosMap.has(prod.bling_id)) continue;
    const novoEstoque = saldosMap.get(prod.bling_id);
    if (prod.estoque === novoEstoque) continue;

    const { error: updateError } = await supabaseServer
      .from('produtos')
      .update({ estoque: novoEstoque })
      .eq('id', prod.id)
      .eq('organizacao_id', scope.organizationId);

    if (updateError) {
      console.error(`Erro ao atualizar estoque do produto ${prod.id}:`, updateError);
    }
  }
}

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const body = await request.json();
    const { pedidoId, novaSituacaoId, novaSituacaoNome } = body;

    if (!pedidoId || !novaSituacaoId || !novaSituacaoNome) {
      return NextResponse.json({ error: 'Dados incompletos (pedidoId, novaSituacaoId, novaSituacaoNome são obrigatórios)' }, { status: 400 });
    }

    // 1. Busca o pedido local
    const pedidoLocal = await pedidoRepository.getById(scope, pedidoId);
    if (!pedidoLocal || !pedidoLocal.bling_id) {
      return NextResponse.json({ error: 'Pedido não encontrado ou sem ID do Bling' }, { status: 404 });
    }

    const blingClient = bling.forUser(session.tenant);

    // 2. Atualiza a situação no Bling
    await blingClient.updateSituacaoPedido(pedidoLocal.bling_id, novaSituacaoId);

    // 3. Atualiza o status localmente no Supabase
    const novoStatusCanonico = mapBlingStatus(novaSituacaoNome);
    await pedidoRepository.upsert(scope, {
      ...pedidoLocal,
      status: novoStatusCanonico
    });

    // 4. Aguarda 2 segundos para o Bling processar as rotinas de estoque e afins (se configurado)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 5. Sincroniza o estoque local dos itens do pedido a partir do Bling
    const stockSyncWarning = await syncEstoqueForPedidoItems(scope, blingClient, pedidoId);
    if (stockSyncWarning) {
      return NextResponse.json({ success: true, warning: stockSyncWarning });
    }

    return NextResponse.json({ success: true, status: novoStatusCanonico });
  } catch (error: unknown) {
    console.error('Erro ao atualizar status do pedido:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro interno';
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
