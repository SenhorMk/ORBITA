/**
 * outboxProviderAdapter.ts
 * Ticket 17: adapter genérico para sistemas alcançados através do outbox
 * durável já existente (`src/services/outboxService.ts`, ticket 12) —
 * usado por `blingAdapter.ts` e `chatwootAdapter.ts`.
 *
 * Reuso deliberado em vez de recriar clientes HTTP: enfileira um evento real
 * e durável (mesma tabela/RPC que já processa `chatwoot`/`bling` hoje) e
 * reflete o status *real* desse evento — nunca declara `completed` sem o
 * outbox ter reportado `sent`. A chave de idempotência é determinística
 * (solicitação + sistema + direito), então reprocessar a mesma tarefa nunca
 * duplica o evento (`registrar_evento_outbox`, migration 31, já deduplica
 * por `idempotency_key`).
 *
 * Gap de infraestrutura pré-existente documentado em
 * `docs/adr/ticket-17-direitos-titular.md` seção 4: nenhuma rota de
 * produção ainda registra adapters reais de provider em
 * `runOutboxWorkerOnce` (ticket 12 deixou o worker pronto mas não ligado).
 * Enquanto isso não for fechado, uma tarefa endereçada a estes destinos
 * permanece honestamente `retryable` até ser efetivamente entregue.
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
