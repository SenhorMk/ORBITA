/**
 * Propagação de eliminação/anonimização (retenção de dados) a providers
 * externos (Bling/Chatwoot) pelo outbox durável (`outbox_eventos` /
 * `registrar_evento_outbox`) — o mesmo mecanismo de `OutboxProviderAdapter`.
 * Não recria cliente HTTP nem lógica de retry: só enfileira um evento
 * idempotente e reflete o status desse evento (não declara `done` sem o outbox
 * ter registrado `sent`).
 *
 * **Limite real** (ver também `docs/adr/ticket-17-direitos-titular.md`, seção
 * 4): a entrega depende do outbox worker (`runOutboxWorkerOnce`) ser executado
 * com adapters de provider, e no código atual nenhuma rota, cron ou processo
 * faz isso. O retry exponencial e o dead letter do outbox
 * (`database/31_outbox_retries_saude_integracoes.sql`) só avançam quando o
 * worker roda; até lá, uma tarefa endereçada a este adapter permanece
 * `retryable`.
 */

import type { RetentionAction, RetentionEffectAdapter, RetentionEffectContext, RetentionItemOutcome } from './retentionTypes';

export type RetentionOutboxEventType = 'retencao.anonimizar_contato' | 'retencao.eliminar_contato';

export type RetentionOutboxEventoStatusRow =
  | { readonly eventoId: string; readonly status: 'sent' }
  | { readonly eventoId: string; readonly status: 'dead_letter'; readonly lastError: string | null }
  | { readonly eventoId: string; readonly status: 'pending' | 'processing' | 'failed_transient' };

/** Porta mínima sobre o outbox — deliberadamente idêntica em forma a
 * `OutboxTitularPort` para reforçar que é o MESMO mecanismo, só
 * testável isoladamente com um fake escrito à mão. */
export interface RetentionOutboxPort {
  ensureEnqueued(params: {
    readonly organizationId: string;
    readonly destination: 'bling' | 'chatwoot';
    readonly eventType: RetentionOutboxEventType;
    readonly idempotencyKey: string;
    readonly payload: Record<string, unknown>;
    readonly correlationId: string;
  }): Promise<RetentionOutboxEventoStatusRow>;
}

function eventTypeFor(action: RetentionAction): RetentionOutboxEventType | null {
  if (action === 'anonymize') return 'retencao.anonimizar_contato';
  if (action === 'delete') return 'retencao.eliminar_contato';
  return null;
}

export class RetentionOutboxAdapter implements RetentionEffectAdapter {
  constructor(
    readonly sistema: Extract<RetentionEffectAdapter['sistema'], 'bling' | 'chatwoot'>,
    private readonly port: RetentionOutboxPort,
  ) {}

  async preview(): Promise<{ readonly wouldApply: boolean }> {
    // Dry-run nunca enfileira evento real no outbox (efeito observável fora
    // do processo) — só reporta que o provider seria alcançado.
    return { wouldApply: true };
  }

  async apply(action: RetentionAction, entidadeId: string, context: RetentionEffectContext): Promise<RetentionItemOutcome> {
    const eventType = eventTypeFor(action);
    if (!eventType) return { status: 'failed', erro: `Acao de retencao nao suportada pelo provider ${this.sistema}: ${action}` };

    const idempotencyKey = `retencao-${context.runId}-${this.sistema}-${entidadeId}`;
    const statusRow = await this.port.ensureEnqueued({
      organizationId: context.organizationId,
      destination: this.sistema,
      eventType,
      idempotencyKey,
      payload: { categoria: context.categoria, entidadeId, action },
      correlationId: context.correlationId,
    });

    if (statusRow.status === 'sent') return { status: 'done' };
    if (statusRow.status === 'dead_letter') {
      return { status: 'failed', erro: statusRow.lastError ?? 'Evento de outbox esgotou tentativas.' };
    }
    return { status: 'retryable', motivo: `Evento de outbox (${statusRow.eventoId}) ainda em ${statusRow.status}.` };
  }
}
