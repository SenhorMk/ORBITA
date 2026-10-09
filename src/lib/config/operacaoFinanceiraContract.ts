import { z } from 'zod';

import { estadoDaOperacaoDeDespesaSchema } from './despesaContract';

/**
 * Contrato único das rotas de operações financeiras (PRE-002), lido pelo
 * servidor e pela tela de operações pendentes.
 */

/** Estado da baixa (quitação), separado do estado da criação. */
export const estadoDaBaixaSchema = z.enum(['em_voo', 'nao_enviada', 'confirmada', 'recusada', 'indeterminada']);

/** Desfecho de um recibo de reconciliação. */
export const resultadoDoReciboSchema = z.enum(['confirmada', 'ja_confirmada', 'revisao_manual', 'divergente']);

/** Por que a reconciliação não concluiu — vocabulário fechado, nunca texto do Bling. */
export const motivoDeRevisaoSchema = z.enum([
  'sem_referencia',
  'consulta_incompleta',
  'listagem_incompleta',
  'nenhum_candidato',
  'multiplos_candidatos',
  'candidato_divergente',
  'candidatos_demais',
  'leitura_inconsistente',
  'conta_ausente',
  'conta_nao_quitada',
]);

export type MotivoDeRevisao = z.infer<typeof motivoDeRevisaoSchema>;

/** Uma operação de conta a pagar, como o operador a vê. */
export const operacaoFinanceiraSchema = z.object({
  ref: z.string().uuid(),
  criacao: estadoDaOperacaoDeDespesaSchema,
  baixa: estadoDaBaixaSchema.nullable(),
  valor: z.number(),
  dataVencimento: z.string(),
  blingContaId: z.string().nullable(),
  ultimaReconciliacao: z.object({
    alvo: z.enum(['criacao', 'baixa']),
    resultado: resultadoDoReciboSchema,
    motivo: motivoDeRevisaoSchema.nullable(),
    em: z.string(),
  }).nullable(),
});

export type OperacaoFinanceira = z.infer<typeof operacaoFinanceiraSchema>;

/** `GET /api/financeiro/operacoes` — as operações com resultado ainda não confirmado. */
export const listaDeOperacoesSchema = z.object({
  success: z.literal(true),
  operacoes: z.array(operacaoFinanceiraSchema),
});

/** `POST /api/financeiro/operacoes/{ref}/reconciliar`. */
export const respostaDaReconciliacaoSchema = z.object({
  success: z.literal(true),
  resultado: z.union([resultadoDoReciboSchema, z.literal('nada_pendente')]),
  motivo: motivoDeRevisaoSchema.nullable(),
  operacao: operacaoFinanceiraSchema,
});

export type RespostaDaReconciliacao = z.infer<typeof respostaDaReconciliacaoSchema>;

/** O que o operador lê depois de "Conferir no Bling". */
export type SituacaoParaOOperador = 'confirmada' | 'ainda_pendente' | 'revisao_manual' | 'sem_pendencia';

/**
 * Traduz o desfecho da reconciliação para o operador.
 *
 * "Ainda pendente" é só quando o Bling não respondeu de forma completa — vale
 * tentar a conferência de novo. Todo o resto que não confirmou é revisão
 * manual: busca vazia, candidatos múltiplos ou divergentes não se resolvem
 * conferindo de novo, e nenhum deles autoriza lançar outra vez.
 *
 * @param resposta - O desfecho devolvido pela rota.
 * @returns A situação a mostrar.
 */
export function situacaoParaOOperador(resposta: Pick<RespostaDaReconciliacao, 'resultado' | 'motivo'>): SituacaoParaOOperador {
  if (resposta.resultado === 'confirmada' || resposta.resultado === 'ja_confirmada') return 'confirmada';
  if (resposta.resultado === 'nada_pendente') return 'sem_pendencia';
  if (resposta.motivo === 'consulta_incompleta' || resposta.motivo === 'listagem_incompleta') return 'ainda_pendente';
  return 'revisao_manual';
}
