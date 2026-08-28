/**
 * blingAdapter.ts
 * Ticket 17: adapter do sistema "bling" — instancia `OutboxProviderAdapter`
 * ligado ao `OutboxService` real (ticket 12). Ver
 * `outboxProviderAdapter.ts` para o mecanismo e as limitações documentadas.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { outboxService } from '@/services/outboxService';
import { OutboxProviderAdapter, type OutboxEventoStatusRow, type OutboxTitularPort } from './outboxProviderAdapter';

export class SupabaseOutboxTitularPort implements OutboxTitularPort {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly scope: VerifiedOrganizationScope,
  ) {}

  async ensureEnqueued(
    params: Parameters<OutboxTitularPort['ensureEnqueued']>[0],
  ): Promise<OutboxEventoStatusRow> {
    const enqueueResult = await outboxService.enqueue(this.supabase, this.scope, {
      idempotencyKey: params.idempotencyKey,
      destination: params.destination,
      eventType: params.eventType,
      payload: { ...params.payload, correlationId: params.correlationId },
    });

    const { data, error } = await this.supabase
      .from('outbox_eventos')
      .select('status, response_body, last_error')
      .eq('id', enqueueResult.eventoId)
      .eq('organizacao_id', this.scope.organizationId)
      .maybeSingle();
    if (error) throw new Error(`Falha ao consultar status do evento de outbox: ${error.message}`);

    const status = (data?.status ?? enqueueResult.status) as OutboxEventoStatusRow['status'];
    if (status === 'sent') {
      return { eventoId: enqueueResult.eventoId, status: 'sent', responseBody: data?.response_body ?? null };
    }
    if (status === 'dead_letter') {
      return { eventoId: enqueueResult.eventoId, status: 'dead_letter', lastError: data?.last_error ?? null };
    }
    return { eventoId: enqueueResult.eventoId, status };
  }
}

export function createBlingAdapter(supabase: SupabaseClient, scope: VerifiedOrganizationScope): OutboxProviderAdapter {
  return new OutboxProviderAdapter('bling', new SupabaseOutboxTitularPort(supabase, scope));
}
