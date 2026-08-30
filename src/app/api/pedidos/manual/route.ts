import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
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
 * Referência local da venda. Não é, e não finge ser, um identificador do
 * Bling: o prefixo `local:` diz isso explicitamente. Substitui o
 * `MANUAL-<Math.random()>` que a versão anterior gravava na coluna `bling_id`
 * como se fosse um ID do ERP.
 */
function newLocalReference(): string {
  return `local:${randomUUID()}`;
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

/** Grava pedido, itens, baixa de estoque e titulo financeiro da venda manual. */
async function persistVenda(input: PersistManualOrderInput): Promise<{ pedidoId: string }> {
  const referencia = input.blingPedidoId ?? input.referenciaLocal;

  const { data: pedido, error: pedidoError } = await supabaseServer
    .from('pedidos')
    .insert({
      user_id: input.scope.actorId,
      organizacao_id: input.scope.organizationId,
      cliente_id: input.clienteId,
      bling_id: referencia,
      numero: referencia,
      data: `${input.dataStr}T00:00:00.000Z`,
      total: input.total,
      desconto: input.desconto,
      frete: input.frete,
      status: 'Entregue',
      origem: 'Loja Física / Manual',
      forma_pagamento: input.formaPagamento,
      observacao: input.observacoes,
    })
    .select('id')
    .single();

  if (pedidoError || !pedido) {
    throw new Error(`não foi possível criar o pedido (${pedidoError?.message ?? 'sem retorno'})`);
  }

  for (const item of input.itens) {
    const { error: itemError } = await supabaseServer.from('itens_pedido').insert({
      user_id: input.scope.actorId,
      organizacao_id: input.scope.organizationId,
      pedido_id: pedido.id,
      produto_id: item.produto.id,
      quantidade: item.quantidade,
      valor_unitario: item.produto.preco,
    });

    if (itemError) {
      throw new Error(`não foi possível registrar o item ${item.produto.nome} (${itemError.message})`);
    }

    // A RPC revalida que o produto pertence à organização informada e
    // recusa estoque negativo; o escopo aqui é sempre o verificado.
    const { error: estoqueError } = await supabaseServer.rpc('baixar_estoque_organizacao', {
      p_organizacao_id: input.scope.organizationId,
      p_produto_id: item.produto.id,
      p_qty: item.quantidade,
    });

    if (estoqueError) {
      throw new Error(`não foi possível baixar o estoque de ${item.produto.nome} (${estoqueError.message})`);
    }
  }

  // `titulos_financeiros.organizacao_id` é NOT NULL desde a migration 45, e
  // o trigger que preenchia a coluna pela primeira associação do usuário foi
  // substituído por um que apenas valida. Omitir a coluna, como a versão
  // anterior fazia, derrubava a venda inteira no último passo.
  const { error: tituloError } = await supabaseServer.from('titulos_financeiros').insert({
    user_id: input.scope.actorId,
    organizacao_id: input.scope.organizationId,
    tipo: 'receber',
    situacao: 'pago',
    valor: input.total,
    data_vencimento: input.dataStr,
    data_pagamento: input.dataStr,
    descricao: `Venda manual ${referencia}`,
  });

  if (tituloError) {
    throw new Error(`não foi possível registrar o título financeiro (${tituloError.message})`);
  }

  return { pedidoId: pedido.id };
}

function blingManualOrderAdapter(client: ReturnType<typeof bling.forVerifiedOrganization>): ManualOrderBlingPort {
  return {
    getDefaultFormaPagamentoId: () => client.obterFormaPagamentoPadraoId(),
    createContato: (input) => client.criarContatoParaVenda(input),
    createPedidoVenda: (payload) => client.criarPedidoVenda(payload),
    lancarEstoquePedido: (pedidoBlingId) => client.lancarEstoquePedidoVenda(pedidoBlingId),
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
