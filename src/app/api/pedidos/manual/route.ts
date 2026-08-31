import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import {
  createManualOrderHandler,
  type ManualOrderAuthPort,
  type ManualOrderBlingPort,
  type ManualOrderCliente,
  type ManualOrderProduto,
  type ManualOrderStorePort,
  type PersistManualOrderInput,
} from './handler';

export type {
  ManualOrderBlingPort,
  ManualOrderDependencies,
  ManualOrderStorePort,
} from './handler';

/**
 * Referência da venda enviada ao Bling em `numeroLoja` — o número do pedido no
 * sistema de origem, que é o campo que o Bling reserva para isso.
 *
 * Desde a migration 53 ela **não** é mais gravada em `pedidos.bling_id`: sem
 * sincronização não existe id do Bling, e a coluna aceita NULL. Antes essa
 * posição era ocupada por `MANUAL-<Math.random()>`, um identificador fictício
 * se passando por ID do ERP.
 */
function newLocalReference(): string {
  return `ORBITA-${randomUUID()}`;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Adapter Supabase da venda manual.
 *
 * Toda consulta e todo insert repetem o predicado `organizacao_id` do escopo
 * verificado. `supabaseServer` usa a service role e ignora RLS, então o
 * predicado aqui é a única barreira que resta.
 */
function supabaseManualOrderStore(): ManualOrderStorePort {
  return {
    async findClienteById(scope: VerifiedOrganizationScope, clienteId: string): Promise<ManualOrderCliente | null> {
      const { data, error } = await supabaseServer
        .from('clientes')
        .select('id, nome, bling_id, email, telefone, cpf_cnpj')
        .eq('organizacao_id', scope.organizationId)
        .eq('id', clienteId)
        .maybeSingle();

      if (error) throw new Error(`Falha ao consultar o cliente: ${error.message}`);
      if (!data) return null;

      return {
        id: data.id,
        nome: data.nome,
        blingId: data.bling_id ?? null,
        email: data.email ?? null,
        telefone: data.telefone ?? null,
        cpfCnpj: data.cpf_cnpj ?? null,
      };
    },

    async linkClienteBlingId(scope: VerifiedOrganizationScope, clienteId: string, blingId: string): Promise<void> {
      const { error } = await supabaseServer
        .from('clientes')
        .update({ bling_id: blingId })
        .eq('organizacao_id', scope.organizationId)
        .eq('id', clienteId);

      if (error) throw new Error(`Falha ao vincular o cliente ao Bling: ${error.message}`);
    },

    async findProdutosByIds(scope: VerifiedOrganizationScope, produtoIds: readonly string[]): Promise<readonly ManualOrderProduto[]> {
      if (produtoIds.length === 0) return [];

      const { data, error } = await supabaseServer
        .from('produtos')
        .select('id, nome, codigo, bling_id, preco, estoque, estoque_reservado')
        .eq('organizacao_id', scope.organizationId)
        .in('id', [...produtoIds]);

      if (error) throw new Error(`Falha ao consultar os produtos: ${error.message}`);

      return (data ?? []).map((row) => ({
        id: row.id,
        nome: row.nome,
        codigo: row.codigo ?? null,
        blingId: row.bling_id ?? null,
        preco: numberOrZero(row.preco),
        estoqueDisponivel: numberOrZero(row.estoque) - numberOrZero(row.estoque_reservado),
      }));
    },

    persistVenda,
  };
}

/**
 * Grava a venda inteira numa transação única.
 *
 * Antes eram quatro chamadas separadas — pedido, itens, baixa de estoque e
 * título financeiro. Uma falha no meio deixava estoque baixado sem título, ou
 * pedido sem itens, sem nenhuma compensação. `registrar_venda_manual`
 * (migration 53) faz tudo de uma vez: ou a venda inteira existe, ou nada
 * existe. A RPC revalida cliente e produtos contra a organização e recusa
 * estoque negativo.
 */
async function persistVenda(input: PersistManualOrderInput): Promise<{ pedidoId: string }> {
  const { data, error } = await supabaseServer.rpc('registrar_venda_manual', {
    p_organizacao_id: input.scope.organizationId,
    p_actor_id: input.scope.actorId,
    p_cliente_id: input.clienteId,
    // Sem sincronização com o Bling não existe id do Bling: a coluna aceita
    // NULL desde a migration 53, em vez de receber um identificador inventado.
    p_bling_pedido_id: input.blingPedidoId,
    p_numero: input.blingPedidoId,
    p_total: input.total,
    p_desconto: input.desconto,
    p_frete: input.frete,
    p_forma_pagamento: input.formaPagamento,
    p_observacoes: input.observacoes,
    p_data: input.dataStr,
    p_itens: input.itens.map((item) => ({
      produto_id: item.produto.id,
      quantidade: item.quantidade,
      valor_unitario: item.produto.preco,
    })),
  });

  if (error) {
    throw new Error(error.message);
  }
  if (typeof data !== 'string') {
    throw new Error('a venda foi registrada mas o banco não devolveu o id do pedido');
  }

  return { pedidoId: data };
}

function blingManualOrderAdapter(client: BlingPort): ManualOrderBlingPort {
  return {
    getDefaultFormaPagamentoId: () => client.obterFormaPagamentoPadraoId(),
    createContato: (input) => client.criarContatoParaVenda(input),
    createPedidoVenda: (payload) => client.criarPedidoVenda(payload),
    lancarEstoquePedido: (pedidoBlingId) => client.lancarEstoquePedidoVenda(pedidoBlingId),
    cancelarPedidoVenda: (pedidoBlingId) => client.cancelarPedidoVenda(pedidoBlingId),
  };
}

/** Sessão e escopo já verificados uma única vez por requisição, reapresentados ao handler. */
function authFor(actorId: string, scope: VerifiedOrganizationScope): ManualOrderAuthPort {
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
    return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
  }

  // O escopo é resolvido aqui, uma vez, porque desde o Ticket 10b o cliente do
  // Bling exige a organização verificada. O handler recebe o mesmo escopo já
  // provado, em vez de resolvê-lo de novo.
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;

  const handler = createManualOrderHandler({
    auth: authFor(session.tenant.id, scope),
    store: supabaseManualOrderStore(),
    bling: blingManualOrderAdapter(bling.forVerifiedOrganization(scope)),
    now: () => new Date(),
    newLocalReference,
  });

  return handler(request);
}
