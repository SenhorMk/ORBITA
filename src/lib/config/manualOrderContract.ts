import { z } from 'zod';

/**
 * Contrato único do corpo de `POST /api/pedidos/manual`.
 *
 * O cliente monta o corpo com `buildManualOrderRequest` (em
 * `useManualOrderSubmit.ts`) e o servidor o valida com `manualOrderRequestSchema`
 * (em `preparacao.ts`) — o mesmo schema nos dois lados da fronteira HTTP,
 * então os dois concordam sobre quais campos existem. Campos fora do schema são
 * descartados na validação (comportamento padrão de `z.object`), não gravados.
 * O schema valida o formato; não substitui o servidor conferir cliente,
 * produtos e posse.
 *
 * O campo `total` **não existe** neste contrato de propósito: o valor da venda
 * é derivado no servidor a partir dos preços cadastrados. Se o cliente enviasse
 * `total`, poderia registrar uma venda por qualquer valor.
 */

export const manualOrderItemSchema = z.object({
  produtoId: z.string().uuid('Item do pedido precisa referenciar um produto por UUID'),
  quantidade: z.number().int().positive('Quantidade do item deve ser um inteiro maior que zero'),
});

export const manualOrderRequestSchema = z.object({
  /** Quando `true`, a venda só é registrada se o Bling confirmar a criação do pedido. */
  syncBling: z.boolean(),
  /** UUID do cliente no ORBITA. O `bling_id` é resolvido no servidor. */
  clienteId: z.string().uuid('Selecione um cliente válido'),
  itens: z.array(manualOrderItemSchema).min(1, 'Adicione ao menos um item ao pedido'),
  desconto: z.number().nonnegative().default(0),
  frete: z.number().nonnegative().default(0),
  observacoes: z.string().trim().max(2000).optional(),
  /**
   * Id da forma de pagamento **na conta Bling do proprietário**
   * (`GET /formas-pagamentos`). Opcional: quando ausente, o servidor usa a
   * forma marcada como padrão na conta. Não é um número fixo no código: os
   * ids são por conta.
   */
  formaPagamentoId: z.number().int().positive().optional(),
  /** Rótulo exibido ao usuário e gravado em `pedidos.forma_pagamento`. */
  formaPagamentoRotulo: z.string().trim().min(1).max(60).optional(),
  /**
   * Âncora de idempotência entre retentativas da MESMA submissão (ver
   * `tentativas_venda_manual`, migration 59). O cliente gera um UUID uma vez
   * por venda e reenvia o MESMO valor se retentar depois de uma resposta
   * ambígua — não um novo a cada clique.
   *
   * Opcional. Sem ele, o servidor gera uma referência nova a cada chamada e
   * perde a identificação exata da MESMA tentativa (não consegue devolver o
   * desfecho dela). A proteção por conteúdo continua: enquanto uma venda
   * idêntica estiver `em_andamento` ou `indeterminada`, o banco recusa outra
   * pendência com o mesmo fingerprint (índice único parcial da migration 59).
   */
  referenciaLocal: z.string().uuid('referenciaLocal precisa ser um UUID').optional(),
});

export type ManualOrderRequest = z.infer<typeof manualOrderRequestSchema>;
/** Entrada do builder: os campos com `default` ainda são opcionais aqui. */
export type ManualOrderRequestInput = z.input<typeof manualOrderRequestSchema>;

/**
 * Monta o corpo de `POST /api/pedidos/manual` a partir do estado do formulário.
 * O retorno é validado pelo mesmo schema que a rota executa, então uma
 * divergência de forma falha aqui, no cliente, antes da requisição.
 */
export function buildManualOrderRequest(input: ManualOrderRequestInput): ManualOrderRequest {
  return manualOrderRequestSchema.parse(input);
}

/** Item já resolvido contra o cadastro local, com o preço que o servidor confia. */
export interface PricedManualOrderItem {
  readonly quantidade: number;
  readonly valorUnitario: number;
}

/**
 * Valor da venda derivado no servidor: soma dos itens pelos preços do cadastro,
 * mais frete, menos desconto. Nunca desce abaixo de zero — um desconto maior
 * que a soma não pode virar um título financeiro negativo.
 */
export function calculateManualOrderTotal(
  itens: readonly PricedManualOrderItem[],
  desconto: number,
  frete: number,
): number {
  const totalItens = itens.reduce((acc, item) => acc + item.quantidade * item.valorUnitario, 0);
  const total = totalItens + frete - desconto;
  return Math.max(0, Math.round(total * 100) / 100);
}
