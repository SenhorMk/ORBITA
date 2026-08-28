import { describe, expect, it } from 'vitest';
import { OutboxProviderAdapter, type OutboxEventoStatusRow, type OutboxTitularPort } from './outboxProviderAdapter';
import type { TitularTaskContext } from './types';

class FakeOutboxTitularPort implements OutboxTitularPort {
  calls: Array<{ idempotencyKey: string }> = [];
  responseByKey = new Map<string, OutboxEventoStatusRow>();
  defaultStatus: 'pending' | 'processing' | 'failed_transient' = 'pending';

  async ensureEnqueued(params: Parameters<OutboxTitularPort['ensureEnqueued']>[0]): Promise<OutboxEventoStatusRow> {
    this.calls.push({ idempotencyKey: params.idempotencyKey });
    const existing = this.responseByKey.get(params.idempotencyKey);
    if (existing) return existing;
    const row: OutboxEventoStatusRow = { eventoId: `evt-${params.idempotencyKey}`, status: this.defaultStatus };
    this.responseByKey.set(params.idempotencyKey, row);
    return row;
  }
}

function contextFor(): TitularTaskContext {
  return {
    organizationId: 'org-1',
    titularTipo: 'cliente_final',
    titularRefUserId: null,
    titularRefClienteId: 'cliente-1',
    solicitacaoId: 'req-1',
    correlationId: 'corr-1',
  };
}

describe('OutboxProviderAdapter', () => {
  it('never returns completed for a freshly enqueued (pending) event — honest retryable', async () => {
    const port = new FakeOutboxTitularPort();
    const adapter = new OutboxProviderAdapter('bling', port);
    const outcome = await adapter.execute('exportacao', contextFor());
    expect(outcome.status).toBe('retryable');
  });

  it('is idempotent: reprocessing the same task never enqueues a second event', async () => {
    const port = new FakeOutboxTitularPort();
    const adapter = new OutboxProviderAdapter('bling', port);
    await adapter.execute('exportacao', contextFor());
    await adapter.execute('exportacao', contextFor());
    const uniqueKeys = new Set(port.calls.map((c) => c.idempotencyKey));
    expect(uniqueKeys.size).toBe(1);
    expect(port.calls.length).toBe(2); // called twice, but idempotencyKey is stable both times
  });

  it('reflects completed only once the outbox reports sent', async () => {
    const port = new FakeOutboxTitularPort();
    port.responseByKey.set('titular-req-1-chatwoot-exclusao', {
      eventoId: 'evt-1',
      status: 'sent',
      responseBody: { deleted: true },
    });
    const adapter = new OutboxProviderAdapter('chatwoot', port);
    const outcome = await adapter.execute('exclusao', contextFor());
    expect(outcome).toEqual({ status: 'completed', data: { deleted: true } });
  });

  it('reflects failed when the outbox event dead-lettered — never hides the failing system', async () => {
    const port = new FakeOutboxTitularPort();
    port.responseByKey.set('titular-req-1-bling-exclusao', {
      eventoId: 'evt-1',
      status: 'dead_letter',
      lastError: 'Bling API 401 apos 5 tentativas',
    });
    const adapter = new OutboxProviderAdapter('bling', port);
    const outcome = await adapter.execute('exclusao', contextFor());
    expect(outcome).toEqual({ status: 'failed', erro: 'Bling API 401 apos 5 tentativas' });
  });
});
