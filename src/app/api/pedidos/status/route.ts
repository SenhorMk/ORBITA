import { NextResponse } from 'next/server';

import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import { saldosComprovados } from './saldosDoBling';
import { getCorrelationId } from '@/lib/observability/correlation';
import { recordAuditEvent } from '@/services/auditService';
import { criarAuditoriaComercial } from '@/services/auditoriaComercial';

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

    async alinharEstoque(scope: VerifiedOrganizationScope, produtoId: string, estoqueLido: number | null, saldoBling: number) {
      const { data, error } = await supabaseServer.rpc('alinhar_estoque_ao_saldo_do_bling', {
        p_organizacao_id: scope.organizationId,
        p_ator_id: scope.actorId,
        p_produto_id: produtoId,
        p_estoque_lido: estoqueLido,
        p_saldo_bling: saldoBling,
      });
      if (error) throw error;
      const linha = Array.isArray(data) ? data[0] : data;
      const desfecho = (linha as { desfecho?: unknown } | null)?.desfecho;
      if (desfecho === 'alinhado' || desfecho === 'ja_alinhado' || desfecho === 'divergiu' || desfecho === 'saldo_invalido') return desfecho;
      throw new Error('alinhar_estoque_ao_saldo_do_bling devolveu um desfecho fora do contrato');
    },
  };
}

/**
 * Adapter do Bling.
 *
 * A leitura do saldo é `saldosComprovados`: só saldo explícito e inteiro entra
 * no mapa, e ausência nunca vira zero. As situações vêm da própria conta
 * (`obterSituacoesDePedidoDeVenda`), para o handler conferir o id pedido.
 */
function blingPedidoStatusAdapter(client: BlingPort): PedidoStatusBlingPort {
  return {
    updateSituacaoPedido(blingPedidoId: string, situacaoId: number) {
      return client.updateSituacaoPedido(blingPedidoId, situacaoId);
    },

    situacoes() {
      return client.obterSituacoesDePedidoDeVenda();
    },

    async getSaldos(blingIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
      return saldosComprovados(await client.getEstoquesSaldos([...blingIds]));
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
  // O ator vem do vínculo persistido (`scope.actorId`), nunca do id da
  // organização. O escopo é resolvido aqui, uma vez, porque o cliente do Bling exige a
  // organização verificada. O handler recebe o mesmo escopo já provado.
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;
  // Mudar a situação mexe no pedido e no estoque, aqui e no Bling: é gestão,
  // como as demais mutações comerciais (PRE-006A). `member` só tem acesso.
  if (!escopoTemCapacidade(scope, 'organization:manage')) {
    return NextResponse.json({ success: false, error: 'Acesso negado' }, { status: 403 });
  }

  const handler = createPedidoStatusHandler({
    auth: authFor(scope.actorId, scope),
    store: supabasePedidoStatusStore(),
    bling: blingPedidoStatusAdapter(bling.forVerifiedOrganization(scope)),
    aguardarProcessamentoBling: () =>
      new Promise((resolve) => setTimeout(resolve, ESPERA_PROCESSAMENTO_BLING_MS)),
    auditar: criarAuditoriaComercial((s, input) => recordAuditEvent(supabaseServer, s, input)),
    correlationId: getCorrelationId,
  });

  return handler(request);
}
