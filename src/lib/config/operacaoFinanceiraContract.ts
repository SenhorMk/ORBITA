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
  'saldo_ausente',
  'bordero_ausente',
  'borderos_demais',
  'quitada_sem_autoria',
  'multiplos_borderos',
  'conta_de_outra_operacao',
  'referencia_de_outra_operacao',
  'sem_evidencia_positiva',
  'titulo_inconsistente',
]);

export type MotivoDeRevisao = z.infer<typeof motivoDeRevisaoSchema>;

/** O que falta resolver na operação, ou `null` quando ela está concluída. */
export const pendenciaSchema = z.enum([
  'conferir_criacao',
  'reparo_titulo',
  'titulo_inconsistente',
  'conferir_baixa',
  'reparo_titulo_pago',
  'quitacao_recusada',
  'pagamento_nao_comprovado',
  'quitacao_solicitada',
]);

/** Em que se apoia o recibo: prova lida no Bling, ou a declaração do operador. */
export const metodoDoReciboSchema = z.enum([
  'referencia_no_numero_documento',
  'leitura_por_id',
  'leitura_de_borderos',
  'confirmacao_manual',
  'declaracao_do_operador',
  'sem_metodo_seguro',
]);

export type Pendencia = z.infer<typeof pendenciaSchema>;

/** Uma operação de conta a pagar, como o operador a vê. */
export const operacaoFinanceiraSchema = z.object({
  ref: z.string().uuid(),
  criacao: estadoDaOperacaoDeDespesaSchema,
  baixa: estadoDaBaixaSchema.nullable(),
  valor: z.number(),
  dataVencimento: z.string(),
  blingContaId: z.string().nullable(),
  /** A quitação foi pedida no lançamento ("pago: true"). */
  quitacaoSolicitada: z.boolean(),
  pendencia: pendenciaSchema.nullable(),
  ultimaReconciliacao: z.object({
    alvo: z.enum(['criacao', 'baixa']),
    metodo: metodoDoReciboSchema,
    resultado: resultadoDoReciboSchema,
    motivo: motivoDeRevisaoSchema.nullable(),
    em: z.string(),
  }).nullable(),
});

export type OperacaoFinanceira = z.infer<typeof operacaoFinanceiraSchema>;

/**
 * `GET /api/financeiro/operacoes[?cursor=…]` — uma página das operações com algo
 * a resolver. `total` conta todas as pendências da organização; `proximoCursor`
 * (opaco) busca a página seguinte, e `incompleta` diz que ela existe.
 */
export const listaDeOperacoesSchema = z.object({
  success: z.literal(true),
  operacoes: z.array(operacaoFinanceiraSchema),
  total: z.number().int().nonnegative(),
  incompleta: z.boolean(),
  proximoCursor: z.string().nullable(),
});

/**
 * Se o ORBITA conta a mesma história que o Bling depois da chamada. `pendente`
 * quando o Bling está resolvido mas o título local ainda não (vínculo, título
 * pago): a operação não é apresentada como concluída.
 */
export const projecaoLocalSchema = z.enum(['consistente', 'pendente']);

/** `POST .../{ref}/reconciliar` e `POST .../{ref}/confirmacao-manual`. */
export const respostaDaReconciliacaoSchema = z.object({
  success: z.literal(true),
  resultado: z.union([resultadoDoReciboSchema, z.literal('nada_pendente'), z.literal('reparo_local')]),
  motivo: motivoDeRevisaoSchema.nullable(),
  projecaoLocal: projecaoLocalSchema,
  operacao: operacaoFinanceiraSchema,
});

export type RespostaDaReconciliacao = z.infer<typeof respostaDaReconciliacaoSchema>;

/**
 * Corpo de `POST .../{ref}/confirmacao-manual`: a conta que o operador conferiu
 * no Bling e, quando ela não traz a referência da operação, a declaração
 * explícita de que é ela.
 */
export const confirmacaoManualSchema = z.object({
  blingContaId: z.string().regex(/^\d{1,20}$/u, 'Informe o número da conta no Bling.'),
  declaracaoDoOperador: z.boolean().default(false),
});

/** Desfecho de `POST .../{ref}/quitacao`. */
export const resultadoDaQuitacaoSchema = z.enum([
  'quitada',
  'quitacao_nao_confirmada',
  'quitacao_recusada',
  'quitacao_nao_enviada',
  'ja_quitada_no_bling',
  'conta_divergente',
  'conta_inconsistente',
  'conta_nao_quitavel',
  'sem_categoria',
  'consulta_incompleta',
  'nada_pendente',
]);

/** `POST /api/financeiro/operacoes/{ref}/quitacao`. */
export const respostaDaQuitacaoSchema = z.object({
  success: z.literal(true),
  resultado: resultadoDaQuitacaoSchema,
  projecaoLocal: projecaoLocalSchema,
  operacao: operacaoFinanceiraSchema,
});

/** O que o operador lê depois de "Conferir no Bling". */
export type SituacaoParaOOperador = 'confirmada' | 'registro_local_pendente' | 'ainda_pendente' | 'revisao_manual' | 'sem_pendencia';

/**
 * Traduz o desfecho da reconciliação para o operador.
 *
 * "Ainda pendente" é só quando o Bling não respondeu de forma completa — vale
 * tentar a conferência de novo. Uma confirmação com a projeção local pendente
 * não é apresentada como conclusão. Todo o resto que não confirmou é revisão
 * manual: busca vazia, candidatos múltiplos ou divergentes não se resolvem
 * conferindo de novo, e nenhum deles autoriza lançar outra vez.
 *
 * @param resposta - O desfecho devolvido pela rota.
 * @returns A situação a mostrar.
 */
export function situacaoParaOOperador(
  resposta: Pick<RespostaDaReconciliacao, 'resultado' | 'motivo' | 'projecaoLocal'>,
): SituacaoParaOOperador {
  const confirmou = resposta.resultado === 'confirmada' || resposta.resultado === 'ja_confirmada'
    || resposta.resultado === 'reparo_local';
  if (confirmou) return resposta.projecaoLocal === 'consistente' ? 'confirmada' : 'registro_local_pendente';
  if (resposta.resultado === 'nada_pendente') return 'sem_pendencia';
  if (resposta.motivo === 'consulta_incompleta' || resposta.motivo === 'listagem_incompleta') return 'ainda_pendente';
  return 'revisao_manual';
}
