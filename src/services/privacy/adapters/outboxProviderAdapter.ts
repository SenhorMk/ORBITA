/**
 * Adapter de direitos do titular para sistemas alcançados pelo outbox durável
 * (`src/services/outboxService.ts`) — usado por `blingAdapter.ts` e
 * `chatwootAdapter.ts`.
 *
 * O que ele faz: **enfileira** um evento no outbox e reflete o status desse
 * evento na tarefa do titular. Não chama o Bling nem o Chatwoot diretamente, e
 * não declara `completed` sem o outbox ter registrado `sent`. A chave de
 * idempotência é determinística (solicitação + sistema + direito), e
 * `registrar_evento_outbox` (migration 31) deduplica por `idempotency_key`:
 * reprocessar a mesma tarefa não enfileira um segundo evento.
 *
 * **Limite real:** a entrega desses eventos depende do outbox worker
 * (`runOutboxWorkerOnce`) ser executado com adapters de provider. No código
 * atual nenhuma rota, cron ou processo registra esses adapters nem agenda o
 * worker. Consequência: uma tarefa endereçada a `bling` ou `chatwoot` fica
 * `retryable` (evento pendente) e não é concluída automaticamente em
 * produção.
 */

import type { AdapterOutcome, DireitoTipo, TarefaSistema, TitularSystemAdapter, TitularTaskContext } from './types';

export type OutboxTitularEventType =
  | 'titular.direitos.exportar_contato'
  | 'titular.direitos.corrigir_contato'
  | 'titular.direitos.eliminar_contato';

export type OutboxEventoStatusRow =
  | { readonly eventoId: string; readonly status: 'sent'; readonly responseBody: Record<string, unknown> | null }
  | { readonly eventoId: string; readonly status: 'dead_letter'; readonly lastError: string | null }
  | { readonly eventoId: string; readonly status: 'pending' | 'processing' | 'failed_transient' };

/** Porta mínima sobre o outbox necessária por este adapter — deliberadamente
 * mais estreita que `OutboxService` inteiro, para poder ser testada com um
 * fake escrito à mão. */
export interface OutboxTitularPort {
  /** Idempotente: se já existe um evento com esta `idempotencyKey` para a
   * organização, retorna o status atual dele em vez de enfileirar de novo. */
  ensureEnqueued(params: {
    readonly organizationId: string;
    readonly destination: 'bling' | 'chatwoot';
    readonly eventType: OutboxTitularEventType;
    readonly idempotencyKey: string;
    readonly payload: Record<string, unknown>;
    readonly correlationId: string;
  }): Promise<OutboxEventoStatusRow>;
}

function eventTypeFor(direito: DireitoTipo): OutboxTitularEventType | null {
  switch (direito) {
    case 'acesso':
    case 'exportacao':
      return 'titular.direitos.exportar_contato';
    case 'correcao':
      return 'titular.direitos.corrigir_contato';
    case 'exclusao':
      return 'titular.direitos.eliminar_contato';
    default:
      return null;
  }
}

/** Adapter reutilizável para qualquer destino do outbox ('bling' | 'chatwoot'). */
export class OutboxProviderAdapter implements TitularSystemAdapter {
  constructor(
    readonly sistema: Extract<TarefaSistema, 'bling' | 'chatwoot'>,
    private readonly port: OutboxTitularPort,
  ) {}

  async execute(
    direito: DireitoTipo,
    context: TitularTaskContext,
    changes?: Readonly<Record<string, unknown>>,
  ): Promise<AdapterOutcome> {
    const eventType = eventTypeFor(direito);
    if (!eventType) {
      return { status: 'failed', erro: `Direito nao suportado pelo provider ${this.sistema}: ${direito}` };
    }

    const idempotencyKey = `titular-${context.solicitacaoId}-${this.sistema}-${direito}`;
    const statusRow = await this.port.ensureEnqueued({
      organizationId: context.organizationId,
      destination: this.sistema,
      eventType,
      idempotencyKey,
      payload: { solicitacaoId: context.solicitacaoId, direito, changes: changes ?? {} },
      correlationId: context.correlationId,
    });

    if (statusRow.status === 'sent') return { status: 'completed', data: statusRow.responseBody ?? undefined };
    if (statusRow.status === 'dead_letter') {
      return { status: 'failed', erro: statusRow.lastError ?? 'Evento de outbox esgotou tentativas.' };
    }
    return { status: 'retryable', motivo: `Evento de outbox (${statusRow.eventoId}) ainda em ${statusRow.status}.` };
  }
}
