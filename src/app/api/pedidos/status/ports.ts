/**
 * Portas e tipos da mudança de situação do pedido (`POST /api/pedidos/status`).
 *
 * Mesma costura já usada por `pedidos/manual`, `categorias/sync` e
 * `bling/pedidos/[id]`: as dependências entram por parâmetro, o `route.ts`
 * resolve escopo e liga os adapters, e o handler fica testável sem subir
 * servidor. Nenhuma costura nova — esta rota era a única de escrita sem teste,
 * e o motivo era exatamente a forma dela.
 */
import type { NextResponse } from 'next/server';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { Pedido } from '@/types';

/**
 * Pedido do ORBITA já lido dentro do escopo verificado da organização.
 *
 * É o próprio tipo de domínio: o handler só olha `bling_id` e devolve o pedido
 * inteiro ao `upsert`, então duplicar a forma aqui só criaria mais uma
 * fronteira para divergir — que é a família de defeito que esta série persegue.
 */
export type PedidoStatusPedido = Pedido;

/** Produto do pedido, com o saldo local que pode divergir do Bling. */
export interface PedidoStatusProduto {
  readonly id: string;
  readonly blingId: string | null;
  readonly estoque: number | null;
}

/**
 * Leitura e escrita no ORBITA. Toda operação recebe o escopo verificado porque
 * `supabaseServer` usa a service role e ignora RLS: o predicado
 * `organizacao_id` no adapter é a única barreira que resta.
 */
export interface PedidoStatusStorePort {
  findPedidoById(scope: VerifiedOrganizationScope, pedidoId: string): Promise<PedidoStatusPedido | null>;
  savePedidoStatus(scope: VerifiedOrganizationScope, pedido: PedidoStatusPedido, status: string): Promise<void>;
  /**
   * Ids dos produtos nos itens do pedido. Lançar aqui vira **aviso**: a
   * situação já mudou nos dois lados, e derrubar a requisição faria o chamador
   * acreditar que nada aconteceu.
   */
  findProdutoIdsDoPedido(scope: VerifiedOrganizationScope, pedidoId: string): Promise<readonly string[]>;
  /** Produtos por id, com o saldo local que pode divergir do Bling. */
  findProdutosByIds(scope: VerifiedOrganizationScope, produtoIds: readonly string[]): Promise<readonly PedidoStatusProduto[]>;
  updateEstoqueProduto(scope: VerifiedOrganizationScope, produtoId: string, estoque: number): Promise<void>;
}

/**
 * As duas chamadas ao Bling desta rota.
 *
 * Ambas lançam, como o cliente real lança: `updateSituacaoPedido` com o corpo
 * do erro HTTP, `getEstoquesSaldos` com `BlingLeituraError`. Nenhuma das duas é
 * engolida — o handler deixa o lançamento chegar à resposta com a causa
 * nomeada, que é o comportamento que a rota já tinha.
 */
export interface PedidoStatusBlingPort {
  /**
   * `PATCH /pedidos/vendas/{idPedido}/situacoes/{idSituacao}`.
   *
   * O id da situação entra no **caminho** da URL, não num corpo: por isso ele é
   * provado inteiro positivo antes de chegar aqui. Não há payload a conferir
   * contra o schema oficial porque este endpoint não tem corpo.
   */
  updateSituacaoPedido(blingPedidoId: string, situacaoId: number): Promise<void>;
  /** `GET /estoques/saldos?idsProdutos[]=…` — saldo físico atual por produto. */
  getSaldos(blingIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export interface PedidoStatusAuthPort {
  /** Identidade do ator derivada da sessão verificada. `null` recusa a requisição. */
  authenticate(request: Request): Promise<{ readonly actorId: string } | null>;
  /** Organização provada contra a associação persistida, nunca vinda do cliente. */
  resolveScope(
    request: Request,
  ): Promise<
    | { readonly _tag: 'Resolved'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Denied'; readonly response: NextResponse }
  >;
}

export interface PedidoStatusDependencies {
  readonly auth: PedidoStatusAuthPort;
  readonly store: PedidoStatusStorePort;
  readonly bling: PedidoStatusBlingPort;
  /**
   * Espera entre atualizar a situação e reler o saldo, para dar tempo às
   * rotinas de estoque do Bling. É dependência para o teste não pagar os 2
   * segundos reais — e para ficar explícito que a espera é uma decisão, não
   * um `setTimeout` perdido no meio do fluxo.
   */
  readonly aguardarProcessamentoBling: () => Promise<void>;
}

/** Corpo de resposta da rota, consumido por `OrderDetailModal`. */
export interface PedidoStatusResponseBody {
  readonly success?: boolean;
  readonly status?: string;
  /** Falha não-bloqueante: a situação mudou, o alinhamento de estoque não. */
  readonly warning?: string;
  readonly error?: string;
}
