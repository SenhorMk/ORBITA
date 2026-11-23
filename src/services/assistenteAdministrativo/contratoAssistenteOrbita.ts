import { z } from 'zod';

export const pedidoAssistente = z.object({
  pergunta: z.string().trim().min(4).max(400),
  organizacaoEsperada: z.string().uuid(),
}).strict();

const data = z.string().date();
const periodo = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('dias'), dias: z.number().int().min(1).max(90) }).strict(),
  z.object({ tipo: z.literal('datas'), inicio: data, fim: data }).strict(),
]);
export type PeriodoAssistente = z.infer<typeof periodo>;
const referencia = z.string().trim().min(1).max(120);
const idPedido = z.string().regex(/^\d{1,18}$/u);

export const ferramentaAssistente = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('vendas_do_periodo'), periodo }).strict(),
  z.object({ acao: z.literal('produtos_mais_vendidos'), periodo, ordenar: z.enum(['quantidade', 'valor']) }).strict(),
  z.object({ acao: z.literal('consultar_estoque'), referencia }).strict(),
  z.object({ acao: z.literal('estoque_baixo'), limite: z.number().int().min(0).max(50) }).strict(),
  z.object({ acao: z.literal('consultar_pedido'), referencia: idPedido, por: z.enum(['numero', 'bling']) }).strict(),
  z.object({ acao: z.literal('consultar_rastreamento'), referencia: idPedido, por: z.enum(['numero', 'bling']) }).strict(),
  z.object({ acao: z.enum(['sem_fonte_procura', 'esclarecer', 'fora_do_escopo']) }).strict(),
]);

export type FerramentaAssistente = z.infer<typeof ferramentaAssistente>;
export type RespostaAssistente = {
  readonly mensagem: string;
  readonly fonte?: string;
  readonly detalhes?: readonly string[];
};
