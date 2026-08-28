/**
 * retentionOutboxAdapter.ts
 * Ticket 18: propagação de eliminação/anonimização a providers externos
 * (Bling/Chatwoot) reusando o outbox durável já existente (ticket 12,
 * `outbox_eventos`/`registrar_evento_outbox`) — o MESMO mecanismo já usado
 * pelo ticket 17 (`OutboxProviderAdapter`/`OutboxTitularPort`). Não recria
 * cliente HTTP nem lógica de retry: só enfileira um evento idempotente e
 * reflete o status real do outbox (nunca declara `done` sem o outbox ter
 * reportado `sent`).
 *
 * Mesma lacuna de infraestrutura documentada em `docs/adr/ticket-17-direitos-titular.md`
 * seção 4: nenhuma rota de produção ainda registra adapters reais de
 * provider em `runOutboxWorkerOnce` — enquanto isso, uma tarefa endereçada a
 * este adapter permanece honestamente `retryable` até ser efetivamente
 * entregue. A "task de reconciliação" pedida pelo ticket 18 é a mesma
 * reconciliação já existente do outbox (retry exponencial + dead letter,
 * `database/31_outbox_retries_saude_integracoes.sql`) — não duplicada aqui.
 */

import type { RetentionAction, RetentionEffectAdapter, RetentionEffectContext, RetentionItemOutcome } from './retentionTypes';

export type RetentionOutboxEventType = 'retencao.anonimizar_contato' | 'retencao.eliminar_contato';

export type RetentionOutboxEventoStatusRow =
  | { readonly eventoId: string; readonly status: 'sent' }
  | { readonly eventoId: string; readonly status: 'dead_letter'; readonly lastError: string | null }
  | { readonly eventoId: string; readonly status: 'pending' | 'processing' | 'failed_transient' };

/** Porta mínima sobre o outbox — deliberadamente idêntica em forma a
 * `OutboxTitularPort` (ticket 17) para reforçar que é o MESMO mecanismo, só
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
