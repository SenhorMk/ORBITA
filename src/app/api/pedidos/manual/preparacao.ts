/**
 * Preparação do pedido: autenticação, validação do corpo, e resolução de
 * cliente/itens contra o cadastro — tudo o que precisa acontecer ANTES de
 * decidir se a submissão é uma tentativa nova ou uma retentativa.
 *
 * Separado de `handler.ts` pelo mesmo motivo de `compensacao.ts`: mantém
 * cada arquivo dentro do limite de tamanho do gate de qualidade, e separa
 * uma responsabilidade própria (validar e resolver a entrada) do fluxo
 * principal (decidir e persistir a venda).
 */
import { NextResponse } from 'next/server';

import {
  calculateManualOrderTotal,
  manualOrderRequestSchema,
  type ManualOrderRequest,
} from '@/lib/config/manualOrderContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type {
  ManualOrderCliente,
  ManualOrderDependencies,
  ManualOrderResponseBody,
  ManualOrderStorePort,
  ResolvedManualOrderItem,
} from './ports';

function json(body: ManualOrderResponseBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

function fail(error: string, status: number, extra: Partial<ManualOrderResponseBody> = {}): NextResponse {
  return json({ success: false, error, ...extra }, status);
}

type ResolveItensResult =
  | { readonly _tag: 'ItensResolved'; readonly itens: readonly ResolvedManualOrderItem[] }
  | { readonly _tag: 'ItensRejected'; readonly response: NextResponse };

/**
 * Casa os itens pedidos com o cadastro local dentro do escopo da organização.
 * O preço usado é sempre o do cadastro: o corpo da requisição não carrega
 * preço nem total justamente para que o cliente não possa ditar o valor.
 */
async function resolveItens(
  scope: VerifiedOrganizationScope,
  body: ManualOrderRequest,
  store: ManualOrderStorePort,
): Promise<ResolveItensResult> {
  const produtoIds = body.itens.map((item) => item.produtoId);
  const duplicados = produtoIds.length !== new Set(produtoIds).size;
  if (duplicados) {
    return { _tag: 'ItensRejected', response: fail('O pedido tem o mesmo produto repetido em itens diferentes. Ajuste a quantidade em vez de repetir o item.', 400) };
  }

  const produtos = await store.findProdutosByIds(scope, produtoIds);
  const porId = new Map(produtos.map((produto) => [produto.id, produto]));

  const itens: ResolvedManualOrderItem[] = [];
  for (const item of body.itens) {
    const produto = porId.get(item.produtoId);
    if (!produto) {
      return { _tag: 'ItensRejected', response: fail(`Produto não encontrado no cadastro desta organização (${item.produtoId}).`, 400) };
    }
    if (produto.estoqueDisponivel < item.quantidade) {
      return {
        _tag: 'ItensRejected',
        response: fail(`Estoque insuficiente para ${produto.nome}. Disponível: ${produto.estoqueDisponivel}, pedido: ${item.quantidade}.`, 400),
      };
    }
    itens.push({ produto, quantidade: item.quantidade });
  }

  return { _tag: 'ItensResolved', itens };
}

export type PedidoPreparadoResult =
  | {
      readonly _tag: 'Preparado';
      readonly scope: VerifiedOrganizationScope;
      readonly body: ManualOrderRequest;
      readonly cliente: ManualOrderCliente;
      readonly itens: readonly ResolvedManualOrderItem[];
      readonly total: number;
    }
  | { readonly _tag: 'Rejeitado'; readonly response: NextResponse };

/**
 * Autentica, valida o corpo, resolve o cliente e os itens contra o cadastro.
 */
export async function prepararPedido(request: Request, deps: ManualOrderDependencies): Promise<PedidoPreparadoResult> {
  const session = await deps.auth.authenticate(request);
  if (!session) {
    return { _tag: 'Rejeitado', response: fail('Não autorizado', 401) };
  }

  const scopeResult = await deps.auth.resolveScope(request);
  if (scopeResult._tag === 'Denied') {
    return { _tag: 'Rejeitado', response: scopeResult.response };
  }
  const { scope } = scopeResult;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { _tag: 'Rejeitado', response: fail('Corpo da requisição não é um JSON válido.', 400) };
  }

  const parsedBody = manualOrderRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    const detalhes = parsedBody.error.issues.map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`).join('; ');
    return { _tag: 'Rejeitado', response: fail(`Pedido inválido: ${detalhes}`, 400) };
  }
  const body = parsedBody.data;

  const cliente = await deps.store.findClienteById(scope, body.clienteId);
  if (!cliente) {
    return { _tag: 'Rejeitado', response: fail('Cliente não encontrado no cadastro desta organização.', 400) };
  }

  const itensResult = await resolveItens(scope, body, deps.store);
  if (itensResult._tag === 'ItensRejected') {
    return { _tag: 'Rejeitado', response: itensResult.response };
  }
  const { itens } = itensResult;

  const total = calculateManualOrderTotal(
    itens.map((item) => ({ quantidade: item.quantidade, valorUnitario: item.produto.preco })),
    body.desconto,
    body.frete,
  );

  return { _tag: 'Preparado', scope, body, cliente, itens, total };
}
