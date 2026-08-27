import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { outboxService } from '@/services/outboxService';
import type { ClaimedOutboxEvent, OutboxDestination } from '@/services/outboxService';

/**
 * Outcome of dispatching one claimed event to its external provider. Never a
 * fabricated success: `success: true` must reflect a real provider response.
 */
export type OutboxDispatchResult =
  | { readonly success: true; readonly responseBody?: Record<string, unknown> | null }
  | { readonly success: false; readonly error: unknown };

/** One provider adapter per outbox destination. The worker never talks to a
 * provider SDK directly — it stays a pure orchestrator (claim -> dispatch ->
 * complete) and delegates the actual external effect to the caller-supplied
 * adapter, which is production-real outside tests. */
export type OutboxProviderAdapter = (event: ClaimedOutboxEvent) => Promise<OutboxDispatchResult>;

export interface OutboxWorkerDeps {
  readonly supabase: SupabaseClient;
  readonly workerId: string;
  readonly providers: Partial<Record<OutboxDestination, OutboxProviderAdapter>>;
  readonly limit?: number;
  readonly leaseTtlSeconds?: number;
  /** Injectable for tests; defaults to the real outboxService singleton. */
  readonly outbox?: Pick<
    typeof outboxService,
    'releaseExpiredLeases' | 'claimBatch' | 'completeClaimedSent' | 'completeClaimedFailed'
  >;
}

export interface OutboxWorkerRunSummary {
  readonly claimed: number;
  readonly sent: number;
  readonly failedTransient: number;
  readonly deadLettered: number;
  readonly reaped: number;
}

/**
 * Runs exactly one pass of the outbox worker: releases expired leases (crash
 * recovery), claims a bounded batch, dispatches each event to its provider
 * adapter, and marks the result. This is a plain invocable async function —
 * no `setInterval`/timer is part of the durable queue. A caller that wants
 * continuous processing (a cron route, a long-running process invoking this
 * in a loop) owns that scheduling decision; the durable state lives entirely
 * in Postgres via lease/attempts/next_retry_at, so a caller that stops
 * calling this function simply pauses — it never loses or duplicates work.
 */
export async function runOutboxWorkerOnce(deps: OutboxWorkerDeps): Promise<OutboxWorkerRunSummary> {
  const outbox = deps.outbox ?? outboxService;
  const limit = deps.limit ?? 20;
  const leaseTtlSeconds = deps.leaseTtlSeconds ?? 300;

  const reaped = await outbox.releaseExpiredLeases(deps.supabase);

  const batch = await outbox.claimBatch(deps.supabase, deps.workerId, limit, leaseTtlSeconds);

  let sent = 0;
  let failedTransient = 0;
  let deadLettered = 0;

  for (const event of batch) {
    const adapter = deps.providers[event.destination];

    if (!adapter) {
      // No adapter registered for this destination: this is a configuration
      // gap, not a transient provider error. Fail permanently (dead_letter)
      // rather than retry forever against a destination nothing will ever
      // handle — proibido retry infinito.
      const ok = await outbox.completeClaimedFailed(
        deps.supabase,
        deps.workerId,
        event.evento_id,
        new Error(`400 Bad Request: nenhum adapter de provider registrado para destination=${event.destination}`),
        event.attempts,
      );
      if (ok) deadLettered++;
      continue;
    }

    let outcome: OutboxDispatchResult;
    try {
      outcome = await adapter(event);
    } catch (err) {
      outcome = { success: false, error: err };
    }

    if (outcome.success) {
      const ok = await outbox.completeClaimedSent(deps.supabase, deps.workerId, event.evento_id, outcome.responseBody);
      if (ok) sent++;
    } else {
      const wasAtMaxAttempts = event.attempts + 1 >= event.max_attempts;
      const ok = await outbox.completeClaimedFailed(
        deps.supabase,
        deps.workerId,
        event.evento_id,
        outcome.error,
        event.attempts,
      );
      if (ok) {
        if (wasAtMaxAttempts) deadLettered++;
        else failedTransient++;
      }
    }
  }

  return {
    claimed: batch.length,
    sent,
    failedTransient,
    deadLettered,
    reaped: reaped.length,
  };
}

/** Generate a stable-enough worker instance id for observability/lease
 * ownership. Callers may supply their own (e.g. a pod name); this is only a
 * convenience default, never authority. */
export function generateWorkerId(prefix = 'outbox-worker'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Runs the worker in a bounded loop until the queue is empty or
 * `maxIterations` is reached, honoring an external abort signal for graceful
 * shutdown. Still no in-memory timer: this is a single invocable call a
 * caller makes once (e.g. from a cron trigger or a drain command), not a
 * background scheduler living in process memory.
 */
export async function drainOutboxWorker(
  deps: OutboxWorkerDeps,
  options: { readonly maxIterations?: number; readonly signal?: AbortSignal } = {},
): Promise<OutboxWorkerRunSummary[]> {
  const maxIterations = options.maxIterations ?? 50;
  const summaries: OutboxWorkerRunSummary[] = [];

  for (let i = 0; i < maxIterations; i++) {
    if (options.signal?.aborted) break;
    const summary = await runOutboxWorkerOnce(deps);
    summaries.push(summary);
    if (summary.claimed === 0) break;
  }

  return summaries;
}
