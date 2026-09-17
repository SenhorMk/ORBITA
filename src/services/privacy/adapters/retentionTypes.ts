/**
 * retentionTypes.ts
 * Contrato comum de todo adapter de efeito de retenção — mesmo padrão de
 * `src/services/privacy/adapters/types.ts` (`TitularSystemAdapter`): um adapter
 * por sistema alcançado, que reporta falha como falha e não declara sucesso
 * sem efeito.
 */

export type RetentionAction = 'anonymize' | 'delete';

export type RetentionItemOutcome =
  | { readonly status: 'done' }
  | { readonly status: 'skipped_already_processed' }
  | { readonly status: 'retryable'; readonly motivo: string }
  | { readonly status: 'failed'; readonly erro: string };

export interface RetentionEffectContext {
  readonly organizationId: string;
  readonly categoria: string;
  readonly runId: string;
  readonly correlationId: string;
}

/** Um adapter de efeito por sistema alcançado pela política de retenção
 * (`banco` para a tabela local, `bling`/`chatwoot` via outbox durável). O
 * dry-run NUNCA invoca `apply` — apenas `preview`, que nunca causa efeito
 * observável fora do processo. */
export interface RetentionEffectAdapter {
  readonly sistema: 'banco' | 'bling' | 'chatwoot';
  preview(action: RetentionAction, entidadeId: string, context: RetentionEffectContext): Promise<{ readonly wouldApply: boolean }>;
  apply(action: RetentionAction, entidadeId: string, context: RetentionEffectContext): Promise<RetentionItemOutcome>;
}
