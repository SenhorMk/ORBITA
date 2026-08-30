import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { mapBlingStatus } from '@/lib/utils';
import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

type BlingClient = ReturnType<typeof bling.forVerifiedOrganization>;

/**
 * Corpo de `POST /api/pedidos/status`. Os ids de situação são por conta
 * (`GET /situacoes/modulos/{idModuloSistema}`), então o valor vem do cliente —
 * mas precisa ser um inteiro positivo, porque compõe o caminho da chamada ao
 * Bling.
 */
const statusRequestSchema = z.object({
  pedidoId: z.string().uuid('pedidoId deve ser um UUID'),
  novaSituacaoId: z.coerce.number().int().positive('novaSituacaoId deve ser um inteiro positivo'),
  novaSituacaoNome: z.string().trim().min(1, 'novaSituacaoNome é obrigatório').max(60),
});

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

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Corpo da requisição não é um JSON válido.' }, { status: 400 });
    }

    // `novaSituacaoId` entra no caminho de `PATCH /pedidos/vendas/{id}/situacoes/{id}`,
    // então precisa ser um inteiro provado aqui e não uma string qualquer do cliente.
    const parsedBody = statusRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      const detalhes = parsedBody.error.issues.map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`).join('; ');
      return NextResponse.json({ error: `Dados inválidos: ${detalhes}` }, { status: 400 });
    }
    const { pedidoId, novaSituacaoId, novaSituacaoNome } = parsedBody.data;

    // 1. Busca o pedido local
    const pedidoLocal = await pedidoRepository.getById(scope, pedidoId);
    if (!pedidoLocal || !pedidoLocal.bling_id) {
      return NextResponse.json({ error: 'Pedido não encontrado ou sem ID do Bling' }, { status: 404 });
    }

    const blingClient = bling.forVerifiedOrganization(scope);

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
