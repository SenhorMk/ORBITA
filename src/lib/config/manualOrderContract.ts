import { z } from 'zod';

/**
 * Contrato único do corpo de `POST /api/pedidos/manual`.
 *
 * Existe pelo mesmo motivo de `blingCredentialsContract.ts`: os dois lados da
 * fronteira eram construídos e verificados isoladamente, cada um coerente
 * consigo mesmo. O `ManualOrderModal` montava `parcelas` e a rota simplesmente
 * não lia esse campo no destructuring do corpo — o mesmo arranjo que produziu
 * os bugs dos tickets 26, 27 e 28.
 *
 * Agora o cliente monta o corpo com `buildManualOrderRequest` e o servidor o
 * valida com `manualOrderRequestSchema`. Um campo que um lado produz e o outro
 * ignora passa a ser impossível por construção.
 *
 * O campo `total` **não existe** neste contrato de propósito: o valor da venda
 * é derivado no servidor a partir dos preços cadastrados. Antes o cliente
 * enviava `total` e ele era gravado em `pedidos.total` e no título financeiro,
 * o que permitia registrar uma venda por qualquer valor.
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
   * forma marcada como padrão na conta. Nunca é um número fixo no código —
   * a versão anterior enviava `1` ou `2` com o comentário "Exemplo simples".
   */
  formaPagamentoId: z.number().int().positive().optional(),
  /** Rótulo exibido ao usuário e gravado em `pedidos.forma_pagamento`. */
  formaPagamentoRotulo: z.string().trim().min(1).max(60).optional(),
  /**
   * Ticket 30, fatia 3 - ancora de idempotencia entre retentativas da MESMA
   * submissao (ver `tentativas_venda_manual`, migration 59). O cliente gera
   * um UUID uma vez por tentativa e reenvia o MESMO valor se retentar depois
   * de uma resposta ambigua - nunca um novo a cada clique.
   *
   * Opcional de proposito: um cliente mais antigo que nao o envie continua
   * funcionando, so sem a protecao contra retentativa. O servidor gera uma
   * referencia propria quando este campo esta ausente, como sempre fez.
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
