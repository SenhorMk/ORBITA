/**
 * types.ts (adapters)
 * Ticket 17: contrato comum de todo adapter de sistema alcançado pela
 * jornada de direitos do titular. Cada adapter retorna exatamente um destes
 * resultados — nunca esconde um sistema que falhou ao processar a
 * solicitação (proibido pelo ticket) e nunca finge sucesso.
 */

export type TarefaSistema = 'banco' | 'bling' | 'chatwoot' | 'stripe' | 'logs';

export type DireitoTipo = 'acesso' | 'exportacao' | 'correcao' | 'exclusao';

export type AdapterOutcome =
  | { readonly status: 'completed'; readonly data?: Record<string, unknown> }
  | { readonly status: 'not_found' }
  | { readonly status: 'retained_with_reason'; readonly fundamento: string }
  | { readonly status: 'retryable'; readonly motivo: string }
  | { readonly status: 'failed'; readonly erro: string };

export interface TitularTaskContext {
  readonly organizationId: string;
  readonly titularTipo: 'lojista_user' | 'cliente_final';
  readonly titularRefUserId: string | null;
  readonly titularRefClienteId: string | null;
  readonly solicitacaoId: string;
  readonly correlationId: string;
}

/** Um adapter por sistema alcançado. `execute` nunca lança para um caminho
 * de negócio esperado (retenção, ausência de dado); exceções verdadeiramente
 * inesperadas devem ser capturadas pelo chamador e viram `failed` com o
 * erro sanitizado (nunca um `catch` vazio). */
export interface TitularSystemAdapter {
  readonly sistema: TarefaSistema;
  execute(
    direito: DireitoTipo,
    context: TitularTaskContext,
    changes?: Readonly<Record<string, unknown>>,
  ): Promise<AdapterOutcome>;
}
