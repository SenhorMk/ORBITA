/**
 * Portas e tipos da venda manual (`POST /api/pedidos/manual`).
 *
 * Separado de `handler.ts` para manter cada arquivo dentro do limite de
 * tamanho do gate de qualidade e para que o adapter Supabase da rota importe
 * apenas o contrato, sem depender da lógica do handler.
 */
import type { NextResponse } from 'next/server';

import type { BlingCallResult, PedidoVendaPayload } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/** Cliente do ORBITA já lido dentro do escopo verificado da organização. */
export interface ManualOrderCliente {
  readonly id: string;
  readonly nome: string;
  readonly blingId: string | null;
  readonly email: string | null;
  readonly telefone: string | null;
  readonly cpfCnpj: string | null;
}

/** Produto já lido dentro do escopo verificado, com o preço em que o servidor confia. */
export interface ManualOrderProduto {
  readonly id: string;
  readonly nome: string;
  readonly codigo: string | null;
  readonly blingId: string | null;
  readonly preco: number;
  readonly estoqueDisponivel: number;
}

/** Item já resolvido: quantidade pedida somada ao produto do cadastro. */
export interface ResolvedManualOrderItem {
  readonly produto: ManualOrderProduto;
  readonly quantidade: number;
}

export interface PersistManualOrderInput {
  readonly scope: VerifiedOrganizationScope;
  readonly clienteId: string;
  readonly blingPedidoId: string | null;
  readonly referenciaLocal: string;
  readonly total: number;
  readonly desconto: number;
  readonly frete: number;
  readonly formaPagamento: string | null;
  readonly observacoes: string | null;
  readonly dataStr: string;
  readonly itens: readonly ResolvedManualOrderItem[];
}

/**
 * Persistência da venda manual. É uma porta única de propósito porque pedido,
 * itens, baixa de estoque e título financeiro precisam cair juntos — a versão
 * anterior espalhava esses quatro efeitos pelo handler e deixava o título
 * financeiro sem `organizacao_id`.
 */
export interface ManualOrderStorePort {
  findClienteById(scope: VerifiedOrganizationScope, clienteId: string): Promise<ManualOrderCliente | null>;
  linkClienteBlingId(scope: VerifiedOrganizationScope, clienteId: string, blingId: string): Promise<void>;
  findProdutosByIds(scope: VerifiedOrganizationScope, produtoIds: readonly string[]): Promise<readonly ManualOrderProduto[]>;
  persistVenda(input: PersistManualOrderInput): Promise<{ readonly pedidoId: string }>;
}

export type { BlingCallResult };

export interface ManualOrderBlingPort {
  /** `GET /formas-pagamentos` — a forma marcada como padrão na conta do proprietário. */
  getDefaultFormaPagamentoId(): Promise<BlingCallResult<number>>;
  /** `POST /contatos` — usado quando o cliente local ainda não tem cadastro no Bling. */
  createContato(input: {
    nome: string;
    email: string | null;
    telefone: string | null;
    documento: string | null;
  }): Promise<BlingCallResult<{ id: number }>>;
  /** `POST /pedidos/vendas` — o payload já vem validado contra o schema oficial. */
  createPedidoVenda(payload: PedidoVendaPayload): Promise<BlingCallResult<{ id: string; alertas: readonly string[] }>>;
  /** `POST /pedidos/vendas/{id}/lancar-estoque` — baixa vinculada ao pedido, no depósito padrão. */
  lancarEstoquePedido(pedidoBlingId: string): Promise<BlingCallResult<void>>;
  /**
   * Compensação: marca como cancelado um pedido que o Bling aceitou e o ORBITA
   * não conseguiu gravar.
   *
   * Cancelar, e não apagar. Apagar destruiria o rastro de que a venda chegou a
   * existir no ERP; cancelado é um estado legítimo que diz "isto não vale", e
   * a sincronização traz o pedido cancelado para cá — os dois lados convergem
   * em vez de um esquecer.
   */
  cancelarPedidoVenda(pedidoBlingId: string): Promise<BlingCallResult<void>>;
}

export interface ManualOrderAuthPort {
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

export interface ManualOrderDependencies {
  readonly auth: ManualOrderAuthPort;
  readonly store: ManualOrderStorePort;
  readonly bling: ManualOrderBlingPort;
  readonly now: () => Date;
  readonly newLocalReference: () => string;
}

/** Corpo de resposta da rota, consumido pelo `ManualOrderModal`. */
export interface ManualOrderResponseBody {
  readonly success: boolean;
  readonly pedidoId?: string;
  readonly blingPedidoId?: string | null;
  readonly total?: number;
  /** Falhas parciais que não invalidam a venda, mas que o usuário precisa ver. */
  readonly avisos?: readonly string[];
  readonly error?: string;
  /** `true` quando o Bling recusou por venda idêntica à última salva. */
  readonly vendaDuplicada?: boolean;
  /**
   * Só aparece quando a gravação local falhou depois de o Bling aceitar.
   *
   * `true`  — o pedido remoto foi cancelado; nada ficou pendente lá.
   * `false` — o cancelamento também falhou e alguém precisa agir no Bling.
   *
   * A distinção é o que separa "pode tentar de novo" de "não tente de novo
   * antes de limpar", e é a diferença entre uma retentativa segura e mais um
   * pedido órfão na conta do lojista.
   */
  readonly compensado?: boolean;
}
