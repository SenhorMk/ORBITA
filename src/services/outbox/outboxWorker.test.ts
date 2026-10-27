import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runOutboxWorkerOnce, drainOutboxWorker, generateWorkerId, type OutboxWorkerDeps } from './outboxWorker';
import type { ClaimedOutboxEvent, OutboxStatus } from '@/services/outboxService';
import type { DesfechoDoDespacho } from './desfechoDoEfeito';

const fakeSupabase = {} as unknown as SupabaseClient;

function claimedEvent(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  return {
    evento_id: 'evt-1',
    organizacao_id: 'org-1',
    conexao_id: null,
    destination: 'chatwoot',
    event_type: 'message.send',
    payload: { content: 'oi' },
    attempts: 0,
    max_attempts: 5,
    lease_owner: 'worker-1',
    lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
    correlation_id: 'corr_1',
    fencing_token: 7,
    ...overrides,
  };
}

const STATUS_DO_DESFECHO: Record<DesfechoDoDespacho['_tag'], OutboxStatus> = {
  Confirmado: 'sent',
  NaoEnviado: 'failed_transient',
  Recusado: 'dead_letter',
  Desconhecido: 'unknown',
};

// Fakes for the outbox data-access seam — the real state machine (SKIP
// LOCKED, fencing, CAS, reaper) is proven by pgTAP against the real database
// in supabase/tests/final/efeito_ambiguo_na_outbox.test.sql, and the failure
// matrix runs against a stateful fake in matrizDeFalhas.test.ts. Here we
// prove the worker's own orchestration (order of operations, what reaches
// the adapter, what is recorded).
function makeFakeOutbox() {
  const calls: string[] = [];
  const releaseExpiredLeases = vi.fn(async () => {
    calls.push('releaseExpiredLeases');
    return [];
  });
  const claimBatch = vi.fn(async () => {
    calls.push('claimBatch');
    return [] as ClaimedOutboxEvent[];
  });
  const startDispatch = vi.fn(async () => {
    calls.push('startDispatch');
    return true;
  });
  const concludeAttempt = vi.fn(async (_s: unknown, _p: unknown, desfecho: DesfechoDoDespacho): Promise<OutboxStatus | null> => {
    calls.push(`concludeAttempt:${desfecho._tag}`);
    return STATUS_DO_DESFECHO[desfecho._tag];
  });
  return { calls, releaseExpiredLeases, claimBatch, startDispatch, concludeAttempt };
}

describe('runOutboxWorkerOnce', () => {
  let fakeOutbox: ReturnType<typeof makeFakeOutbox>;

  beforeEach(() => {
    fakeOutbox = makeFakeOutbox();
  });

  it('releases expired leases before claiming a new batch (crash recovery ordering)', async () => {
    await runOutboxWorkerOnce({ supabase: fakeSupabase, workerId: 'worker-1', providers: {}, outbox: fakeOutbox });

    expect(fakeOutbox.calls[0]).toBe('releaseExpiredLeases');
    expect(fakeOutbox.calls[1]).toBe('claimBatch');
  });

  it('records in_flight before calling the adapter and concludes under the same fencing token', async () => {
    fakeOutbox.claimBatch.mockResolvedValueOnce([claimedEvent()]);
    const adapter = vi.fn(async (): Promise<DesfechoDoDespacho> => {
      fakeOutbox.calls.push('adapter');
      return { _tag: 'Confirmado', recibo: '999' };
    });

    const summary = await runOutboxWorkerOnce({ supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: adapter }, outbox: fakeOutbox });

    expect(fakeOutbox.calls).toEqual(['releaseExpiredLeases', 'startDispatch', 'adapter', 'concludeAttempt:Confirmado']);
    expect(fakeOutbox.startDispatch).toHaveBeenCalledWith(fakeSupabase, 'evt-1', 'worker-1', 7);
    expect(fakeOutbox.concludeAttempt).toHaveBeenCalledWith(
      fakeSupabase,
      { eventoId: 'evt-1', workerId: 'worker-1', fencingToken: 7 },
      { _tag: 'Confirmado', recibo: '999' },
    );
    expect(summary.sent).toBe(1);
  });

  it('never calls the adapter when the dispatch could not be recorded (lost lease)', async () => {
    fakeOutbox.claimBatch.mockResolvedValueOnce([claimedEvent()]);
    fakeOutbox.startDispatch.mockResolvedValueOnce(false);
    const adapter = vi.fn();

    const summary = await runOutboxWorkerOnce({ supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: adapter }, outbox: fakeOutbox });

    expect(adapter).not.toHaveBeenCalled();
    expect(fakeOutbox.concludeAttempt).not.toHaveBeenCalled();
    expect(summary.fenced).toBe(1);
  });

  it('records an adapter exception after dispatch as unknown, never as a retryable failure', async () => {
    fakeOutbox.claimBatch.mockResolvedValueOnce([claimedEvent()]);
    const adapter = vi.fn(async (): Promise<DesfechoDoDespacho> => {
      throw new Error('ECONNRESET');
    });
    const aoFicarDesconhecido = vi.fn(async () => {});

    const summary = await runOutboxWorkerOnce({
      supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: adapter }, outbox: fakeOutbox, aoFicarDesconhecido,
    });

    expect(fakeOutbox.concludeAttempt).toHaveBeenCalledWith(
      fakeSupabase,
      expect.anything(),
      expect.objectContaining({ _tag: 'Desconhecido', motivo: 'falha_apos_despacho' }),
    );
    expect(summary).toMatchObject({ unknown: 1, failedTransient: 0, sent: 0 });
    expect(aoFicarDesconhecido).toHaveBeenCalledTimes(1);
  });

  it('records an outcome outside the contract (confirmed without receipt) as unknown', async () => {
    fakeOutbox.claimBatch.mockResolvedValueOnce([claimedEvent()]);
    const adapter = vi.fn(async () => ({ _tag: 'Confirmado', recibo: '   ' }) as DesfechoDoDespacho);

    const summary = await runOutboxWorkerOnce({ supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: adapter }, outbox: fakeOutbox });

    expect(fakeOutbox.calls).not.toContain('concludeAttempt:Confirmado');
    expect(summary).toMatchObject({ unknown: 1, sent: 0 });
  });

  it('refuses a destination with no adapter from the claim, without dispatching', async () => {
    fakeOutbox.claimBatch.mockResolvedValueOnce([claimedEvent({ destination: 'bling' })]);
    const chatwootAdapter = vi.fn();

    const summary = await runOutboxWorkerOnce({ supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: chatwootAdapter }, outbox: fakeOutbox });

    expect(chatwootAdapter).not.toHaveBeenCalled();
    expect(fakeOutbox.startDispatch).not.toHaveBeenCalled();
    expect(fakeOutbox.concludeAttempt).toHaveBeenCalledWith(
      fakeSupabase,
      expect.anything(),
      expect.objectContaining({ _tag: 'Recusado', codigo: 'sem_adapter' }),
    );
    expect(summary.deadLettered).toBe(1);
  });

  it('counts a conclusion refused by the fencing CAS and does not report it as sent', async () => {
    fakeOutbox.claimBatch.mockResolvedValueOnce([claimedEvent()]);
    fakeOutbox.concludeAttempt.mockResolvedValueOnce(null);
    const adapter = vi.fn(async (): Promise<DesfechoDoDespacho> => ({ _tag: 'Confirmado', recibo: '1' }));

    const summary = await runOutboxWorkerOnce({ supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: adapter }, outbox: fakeOutbox });

    expect(summary).toMatchObject({ sent: 0, fenced: 1 });
  });

  it('keeps going when the unknown-effect audit fails', async () => {
    fakeOutbox.claimBatch.mockResolvedValueOnce([claimedEvent({ evento_id: 'a' }), claimedEvent({ evento_id: 'b' })]);
    const adapter = vi.fn(async (): Promise<DesfechoDoDespacho> => ({ _tag: 'Desconhecido', motivo: 'timeout', erro: 'x' }));

    const summary = await runOutboxWorkerOnce({
      supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: adapter }, outbox: fakeOutbox,
      aoFicarDesconhecido: async () => { throw new Error('auditoria fora'); },
    });

    expect(summary.unknown).toBe(2);
  });
});

describe('drainOutboxWorker', () => {
  const confirma = async (): Promise<DesfechoDoDespacho> => ({ _tag: 'Confirmado', recibo: '1' });

  it('stops looping once a pass claims nothing (queue drained)', async () => {
    const fakeOutbox = makeFakeOutbox();
    fakeOutbox.claimBatch
      .mockResolvedValueOnce([claimedEvent({ evento_id: 'evt-1' })])
      .mockResolvedValueOnce([claimedEvent({ evento_id: 'evt-2' })])
      .mockResolvedValueOnce([]);

    const deps: OutboxWorkerDeps = { supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: confirma }, outbox: fakeOutbox };
    const summaries = await drainOutboxWorker(deps, { maxIterations: 10 });

    expect(summaries).toHaveLength(3);
    expect(fakeOutbox.claimBatch).toHaveBeenCalledTimes(3);
  });

  it('stops on an already-aborted signal without claiming any batch (graceful shutdown)', async () => {
    const fakeOutbox = makeFakeOutbox();
    const controller = new AbortController();
    controller.abort();

    const summaries = await drainOutboxWorker(
      { supabase: fakeSupabase, workerId: 'worker-1', providers: {}, outbox: fakeOutbox },
      { signal: controller.signal, maxIterations: 10 },
    );

    expect(summaries).toHaveLength(0);
    expect(fakeOutbox.claimBatch).not.toHaveBeenCalled();
  });

  it('respects maxIterations as a hard cap even if the queue never empties', async () => {
    const fakeOutbox = makeFakeOutbox();
    fakeOutbox.claimBatch.mockResolvedValue([claimedEvent()]);

    const summaries = await drainOutboxWorker(
      { supabase: fakeSupabase, workerId: 'worker-1', providers: { chatwoot: confirma }, outbox: fakeOutbox },
      { maxIterations: 3 },
    );

    expect(summaries).toHaveLength(3);
  });
});

describe('generateWorkerId', () => {
  it('produces unique, prefixed ids', () => {
    const a = generateWorkerId();
    const b = generateWorkerId();
    expect(a).not.toBe(b);
    expect(a.startsWith('outbox-worker_')).toBe(true);
  });
});
