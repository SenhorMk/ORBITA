import { NextResponse } from 'next/server';

import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';

import {
  createPedidoStatusHandler,
  type PedidoStatusAuthPort,
  type PedidoStatusBlingPort,
  type PedidoStatusProduto,
  type PedidoStatusStorePort,
} from './handler';

export type {
  PedidoStatusBlingPort,
  PedidoStatusDependencies,
  PedidoStatusStorePort,
} from './handler';

/** Tempo dado ao Bling para rodar as rotinas de estoque antes de reler o saldo. */
const ESPERA_PROCESSAMENTO_BLING_MS = 2000;

/**
 * Adapter Supabase da mudança de situação.
 *
 * Toda consulta repete o predicado `organizacao_id` do escopo verificado.
 * `supabaseServer` usa a service role e ignora RLS, então o predicado aqui é a
 * única barreira que resta — é ele que faz o pedido de outra organização
 * simplesmente não existir.
 */
function supabasePedidoStatusStore(): PedidoStatusStorePort {
  return {
    findPedidoById(scope, pedidoId) {
      return pedidoRepository.getById(scope, pedidoId);
    },

    async savePedidoStatus(scope, pedido, status) {
      await pedidoRepository.upsert(scope, { ...pedido, status });
    },

    async findProdutoIdsDoPedido(scope: VerifiedOrganizationScope, pedidoId: string): Promise<readonly string[]> {
      const { data, error } = await supabaseServer
        .from('itens_pedido')
        .select('produto_id')
        .eq('pedido_id', pedidoId)
        .eq('organizacao_id', scope.organizationId);

      if (error) throw error;
      return (data || []).map((item) => String(item.produto_id));
    },

    async findProdutosByIds(
      scope: VerifiedOrganizationScope,
      produtoIds: readonly string[],
    ): Promise<readonly PedidoStatusProduto[]> {
      const { data, error } = await supabaseServer
        .from('produtos')
        .select('id, bling_id, estoque')
        .in('id', [...produtoIds])
        .eq('organizacao_id', scope.organizationId);

      if (error) throw error;
      return (data || []).map((p) => ({
        id: String(p.id),
        blingId: p.bling_id ? String(p.bling_id) : null,
        estoque: p.estoque === null || p.estoque === undefined ? null : Number(p.estoque),
      }));
    },

    async updateEstoqueProduto(scope: VerifiedOrganizationScope, produtoId: string, estoque: number): Promise<void> {
      const { error } = await supabaseServer
        .from('produtos')
        .update({ estoque })
        .eq('id', produtoId)
        .eq('organizacao_id', scope.organizationId);

      if (error) throw error;
    },
  };
}

/**
 * Adapter do Bling.
 *
 * `getEstoquesSaldos` devolve a lista crua da API; o formato do saldo varia
 * entre `saldoFisicoTotal` e `saldoFisico` conforme o endpoint responde, e essa
 * normalização vive aqui — o handler recebe um mapa e não precisa saber disso.
 */
function blingPedidoStatusAdapter(client: BlingPort): PedidoStatusBlingPort {
  return {
    async updateSituacaoPedido(blingPedidoId: string, situacaoId: number): Promise<void> {
      await client.updateSituacaoPedido(blingPedidoId, situacaoId);
    },

    async getSaldos(blingIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
      const saldosArray = await client.getEstoquesSaldos([...blingIds]);
      const saldos = new Map<string, number>();
      for (const item of saldosArray as Array<{
        produto?: { id: number | string };
        saldoFisicoTotal?: number;
        saldoFisico?: number;
      }>) {
        if (item.produto?.id === undefined) continue;
        saldos.set(String(item.produto.id), Number(item.saldoFisicoTotal ?? item.saldoFisico ?? 0));
      }
      return saldos;
    },
  };
}

/** Sessão e escopo já verificados uma única vez por requisição, reapresentados ao handler. */
function authFor(actorId: string, scope: VerifiedOrganizationScope): PedidoStatusAuthPort {
  return {
    async authenticate() {
      return { actorId };
    },
    async resolveScope() {
      return { _tag: 'Resolved' as const, scope };
    },
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await verifySessionAndRole(request);
  if (!session?.tenant.id) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  // O escopo é resolvido aqui, uma vez, porque o cliente do Bling exige a
  // organização verificada. O handler recebe o mesmo escopo já provado.
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;

  const handler = createPedidoStatusHandler({
    auth: authFor(session.tenant.id, scope),
    store: supabasePedidoStatusStore(),
    bling: blingPedidoStatusAdapter(bling.forVerifiedOrganization(scope)),
    aguardarProcessamentoBling: () =>
      new Promise((resolve) => setTimeout(resolve, ESPERA_PROCESSAMENTO_BLING_MS)),
  });

  return handler(request);
}
