import { z } from 'zod';

/**
 * Contrato único do corpo de `POST /api/financeiro` (lançamento de despesa).
 *
 * Quinto da série. O corpo era destructurado cru de `await request.json()`,
 * com validação por `if (!descricao || !valor || !data_vencimento)` — o que
 * também recusava silenciosamente um valor `0` legítimo.
 */

/** `format: date` do Bling — AAAA-MM-DD, sem componente de hora. */
const dataSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Data deve estar no formato AAAA-MM-DD');

export const despesaRequestSchema = z.object({
  /**
   * Nome curto da despesa. **Opcional**: o Bling não tem esse campo — lá só
   * existe o `historico`, que continua sendo a `descricao`. Ele é um conceito
   * local, gravado na coluna `titulo` (migration 62), e nada no ERP muda por
   * causa dele.
   */
  titulo: z.string().trim().min(1).max(120).optional(),
  descricao: z.string().trim().min(1, 'A descrição é obrigatória').max(200),
  valor: z.number().positive('O valor da despesa deve ser maior que zero'),
  dataVencimento: dataSchema,
  categoriaId: z.string().uuid().optional(),
  /** Id do contato/fornecedor no Bling. Quando ausente, o servidor resolve. */
  contatoBlingId: z.number().int().positive().optional(),
  /**
   * Nome do contato no momento do lançamento, para o histórico da despesa
   * continuar legível se o contato for renomeado ou removido no ERP. É um
   * retrato, **não** uma chave: nada é procurado por ele, e o `contatoBlingId`
   * é que identifica o fornecedor.
   */
  contatoNome: z.string().trim().min(1).max(200).optional(),
  /**
   * `interno` grava só no ORBITA; `contabil` cria a conta a pagar no Bling.
   * O padrão é `contabil`: o Bling é a fonte da verdade.
   */
  modo: z.enum(['contabil', 'interno']).default('contabil'),
  /**
   * Despesa já quitada. **Não** vira `situacao` no payload de criação: no
   * schema oficial `situacao` é `readOnly` e o Bling ignora o valor enviado.
   * Quitar exige `POST /contas/pagar/{id}/baixar`.
   */
  pago: z.boolean().default(false),
  /**
   * Identidade da operação, gerada pelo navegador ANTES da rede e reenviada em
   * toda retentativa da mesma submissão. É ela que permite ao servidor
   * reconhecer "esta é a MESMA operação" e não criar uma segunda conta a pagar
   * no Bling — que não oferece chave de idempotência própria.
   *
   * Obrigatória no modo `contabil`: sem ela a rota recusa antes de qualquer
   * efeito, e o servidor nunca gera uma. Opcional no modo `interno`, que não
   * tem efeito externo. Opcional no schema porque o formulário monta o corpo
   * antes de saber a chave (ela depende do digest do conteúdo).
   */
  chaveIdempotencia: z.string().uuid().optional(),
});

export type DespesaRequest = z.infer<typeof despesaRequestSchema>;
export type DespesaRequestInput = z.input<typeof despesaRequestSchema>;

/** Monta o corpo de `POST /api/financeiro`, validado pelo schema da rota. */
export function buildDespesaRequest(input: DespesaRequestInput): DespesaRequest {
  return despesaRequestSchema.parse(input);
}

/**
 * Estado da operação de lançamento contábil, como a API o devolve.
 *
 * `em_voo` e `indeterminada` significam "o resultado ainda não foi
 * confirmado": a conta a pagar pode existir no Bling, e lançar de novo pode
 * duplicá-la. Nenhum dos dois é recusa.
 */
export const estadoDaOperacaoDeDespesaSchema = z.enum([
  'em_voo',
  'nao_enviada',
  'confirmada',
  'recusada',
  'indeterminada',
]);

export type EstadoDaOperacaoDeDespesa = z.infer<typeof estadoDaOperacaoDeDespesaSchema>;

/** A operação devolvida por `POST /api/financeiro` no modo contábil. */
export const operacaoDeDespesaSchema = z.object({
  /** A `chaveIdempotencia` da operação: a referência para conferir depois. */
  ref: z.string().uuid(),
  estado: estadoDaOperacaoDeDespesaSchema,
});

export type OperacaoDeDespesa = z.infer<typeof operacaoDeDespesaSchema>;

/** Corpo de resposta de `POST /api/financeiro`, lido pelo formulário. */
export const despesaRespostaSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  avisos: z.array(z.string()).optional(),
  operacao: operacaoDeDespesaSchema.optional(),
});

/**
 * O resultado desta operação ainda não foi confirmado?
 *
 * @param estado - Estado devolvido pela API.
 * @returns `true` para `em_voo` e `indeterminada`: lançar de novo pode criar
 *   uma segunda conta a pagar no Bling.
 */
export function resultadoNaoConfirmado(estado: EstadoDaOperacaoDeDespesa): boolean {
  return estado === 'em_voo' || estado === 'indeterminada';
}
