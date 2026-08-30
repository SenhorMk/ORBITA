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
  descricao: z.string().trim().min(1, 'A descrição é obrigatória').max(200),
  valor: z.number().positive('O valor da despesa deve ser maior que zero'),
  dataVencimento: dataSchema,
  categoriaId: z.string().uuid().optional(),
  /** Id do contato/fornecedor no Bling. Quando ausente, o servidor resolve. */
  contatoBlingId: z.number().int().positive().optional(),
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
});

export type DespesaRequest = z.infer<typeof despesaRequestSchema>;
export type DespesaRequestInput = z.input<typeof despesaRequestSchema>;

/** Monta o corpo de `POST /api/financeiro`, validado pelo schema da rota. */
export function buildDespesaRequest(input: DespesaRequestInput): DespesaRequest {
  return despesaRequestSchema.parse(input);
}
