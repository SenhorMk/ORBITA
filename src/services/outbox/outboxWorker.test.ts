import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runOutboxWorkerOnce, drainOutboxWorker, generateWorkerId, type OutboxWorkerDeps } from './outboxWorker';
import type { ClaimedOutboxEvent } from '@/services/outboxService';

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
    ...overrides,
  };
}

// Fakes for the outbox data-access seam — real behavior (SKIP LOCKED, lease
// ownership, backoff) is proven by pgTAP against the real database in
// supabase/tests/database/outbox_lease_correlacao.test.sql. Here we prove
// the worker's own orchestration logic (order of operations, dispatch
// routing, no-adapter handling, no silent swallow) in isolation.
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
  const completeClaimedSent = vi.fn(async () => {
    calls.push('completeClaimedSent');
    return true;
  });
  const completeClaimedFailed = vi.fn(async () => {
    calls.push('completeClaimedFailed');
    return true;
  });
  return { calls, releaseExpiredLeases, claimBatch, completeClaimedSent, completeClaimedFailed };
}

describe('runOutboxWorkerOnce', () => {
  let fakeOutbox: ReturnType<typeof makeFakeOutbox>;

  beforeEach(() => {
    fakeOutbox = makeFakeOutbox();
  });

  it('releases expired leases before claiming a new batch (crash recovery ordering)', async () => {
    await runOutboxWorkerOnce({
      supabase: fakeSupabase,
      workerId: 'worker-1',
      providers: {},
      outbox: fakeOutbox,
    });

    expect(fakeOutbox.calls[0]).toBe('releaseExpiredLeases');
    expect(fakeOutbox.calls[1]).toBe('claimBatch');
  });

  it('dispatches a claimed event to its provider adapter and marks it sent on success', async () => {
    const event = claimedEvent();
    fakeOutbox.claimBatch.mockResolvedValueOnce([event]);
    const adapter = vi.fn(async () => ({ success: true as const, responseBody: { id: 999 } }));

    const summary = await runOutboxWorkerOnce({
      supabase: fakeSupabase,
      workerId: 'worker-1',
      providers: { chatwoot: adapter },
      outbox: fakeOutbox,
    });

    expect(adapter).toHaveBeenCalledWith(event);
    expect(fakeOutbox.completeClaimedSent).toHaveBeenCalledWith(fakeSupabase, 'worker-1', 'evt-1', { id: 999 });
    expect(summary).toEqual({ claimed: 1, sent: 1, failedTransient: 0, deadLettered: 0, reaped: 0 });
  });

  it('marks a failing event as failed_transient when attempts remain', async () => {
    const event = claimedEvent({ attempts: 0, max_attempts: 5 });
    fakeOutbox.claimBatch.mockResolvedValueOnce([event]);
    const adapter = vi.fn(async () => ({ success: false as const, error: new Error('503 Service Unavailable') }));

    const summary = await runOutboxWorkerOnce({
      supabase: fakeSupabase,
      workerId: 'worker-1',
      providers: { chatwoot: adapter },
      outbox: fakeOutbox,
    });

    expect(fakeOutbox.completeClaimedFailed).toHaveBeenCalledWith(
      fakeSupabase,
      'worker-1',
      'evt-1',
      expect.any(Error),
      0,
    );
    expect(summary.failedTransient).toBe(1);
    expect(summary.deadLettered).toBe(0);
  });

  it('counts a failure at max_attempts as dead-lettered instead of retryable', async () => {
    const event = claimedEvent({ attempts: 4, max_attempts: 5 });
    fakeOutbox.claimBatch.mockResolvedValueOnce([event]);
    const adapter = vi.fn(async () => ({ success: false as const, error: new Error('permanent failure') }));

    const summary = await runOutboxWorkerOnce({
      supabase: fakeSupabase,
      workerId: 'worker-1',
      providers: { chatwoot: adapter },
      outbox: fakeOutbox,
    });

    expect(summary.failedTransient).toBe(0);
    expect(summary.deadLettered).toBe(1);
  });

  it('dead-letters an event with no registered provider adapter, without ever attempting delivery', async () => {
    const event = claimedEvent({ destination: 'bling' });
    fakeOutbox.claimBatch.mockResolvedValueOnce([event]);
    const chatwootAdapter = vi.fn();

    const summary = await runOutboxWorkerOnce({
      supabase: fakeSupabase,
      workerId: 'worker-1',
      providers: { chatwoot: chatwootAdapter },
      outbox: fakeOutbox,
    });

    expect(chatwootAdapter).not.toHaveBeenCalled();
    expect(fakeOutbox.completeClaimedFailed).toHaveBeenCalledWith(
      fakeSupabase,
      'worker-1',
      'evt-1',
      expect.objectContaining({ message: expect.stringContaining('nenhum adapter') }),
      0,
    );
    expect(summary.deadLettered).toBe(1);
  });

  it('never crashes and never fabricates success when the provider adapter throws', async () => {
    const event = claimedEvent();
    fakeOutbox.claimBatch.mockResolvedValueOnce([event]);
    const adapter = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    const summary = await expect(
      runOutboxWorkerOnce({
        supabase: fakeSupabase,
        workerId: 'worker-1',
        providers: { chatwoot: adapter },
        outbox: fakeOutbox,
      }),
    ).resolves.toBeDefined();

    expect(fakeOutbox.completeClaimedSent).not.toHaveBeenCalled();
    expect(fakeOutbox.completeClaimedFailed).toHaveBeenCalled();
    void summary;
  });

  it('processes multiple claimed events independently in one pass', async () => {
    const eventA = claimedEvent({ evento_id: 'evt-a', destination: 'chatwoot' });
    const eventB = claimedEvent({ evento_id: 'evt-b', destination: 'bling' });
    fakeOutbox.claimBatch.mockResolvedValueOnce([eventA, eventB]);
    const chatwootAdapter = vi.fn(async () => ({ success: true as const }));
    const blingAdapter = vi.fn(async () => ({ success: true as const }));

    const summary = await runOutboxWorkerOnce({
      supabase: fakeSupabase,
      workerId: 'worker-1',
      providers: { chatwoot: chatwootAdapter, bling: blingAdapter },
      outbox: fakeOutbox,
    });

    expect(summary.sent).toBe(2);
    expect(chatwootAdapter).toHaveBeenCalledTimes(1);
    expect(blingAdapter).toHaveBeenCalledTimes(1);
  });
});

describe('drainOutboxWorker', () => {
  it('stops looping once a pass claims nothing (queue drained)', async () => {
    const fakeOutbox = makeFakeOutbox();
    fakeOutbox.claimBatch
      .mockResolvedValueOnce([claimedEvent({ evento_id: 'evt-1' })])
      .mockResolvedValueOnce([claimedEvent({ evento_id: 'evt-2' })])
      .mockResolvedValueOnce([]);

    const deps: OutboxWorkerDeps = {
      supabase: fakeSupabase,
      workerId: 'worker-1',
      providers: { chatwoot: async () => ({ success: true }) },
      outbox: fakeOutbox,
    };

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
      {
        supabase: fakeSupabase,
        workerId: 'worker-1',
        providers: { chatwoot: async () => ({ success: true }) },
        outbox: fakeOutbox,
      },
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
