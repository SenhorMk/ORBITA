import { z } from 'zod';

/** Contrato puro (só Zod): também é importado pelo painel no navegador. */
const itemDoModelo = {
  referencia: z.string().trim().min(2).max(120),
  operacao: z.enum(['definir', 'somar', 'subtrair']),
  quantidade: z.number().int().min(0).max(1_000_000),
};

/**
 * Esquema ENVIADO ao modelo: sem limites de tamanho de lista, que o modo estrito
 * da Groq pode recusar. `pedidoEstoqueEmLote` reaplica o limite de 1 a 20 itens.
 */
export const estoqueEmLoteDoModelo = z.object({
  acao: z.literal('estoque_em_lote'),
  itens: z.array(z.object(itemDoModelo).strict()),
}).strict();

/** Vários produtos, cada um com a sua operação; o servidor resolve os produtos e calcula o saldo final. */
export const pedidoEstoqueEmLote = estoqueEmLoteDoModelo.extend({
  itens: z.array(z.object(itemDoModelo).strict()).min(1).max(20),
});
/** Pedido de estoque em lote interpretado, ainda sem autoridade sobre produtos. */
export type PedidoEstoqueEmLote = z.infer<typeof pedidoEstoqueEmLote>;
