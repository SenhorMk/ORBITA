import { describe, expect, it } from 'vitest';
import {
  applyTitularRequestEvent,
  initialTitularRequestState,
  stateAllowsDataDisclosure,
  type VersionedTitularRequestState,
} from './titularRequestStateMachine';

describe('titularRequestStateMachine', () => {
  it('starts in received', () => {
    const state = initialTitularRequestState('2026-01-01T00:00:00Z');
    expect(state.state.kind).toBe('received');
    expect(state.version).toBe(0);
  });

  it('walks the full happy path received -> completed', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');

    const steps: Array<{ type: Parameters<typeof applyTitularRequestEvent>[1]['type']; extra?: Record<string, unknown> }> = [
      { type: 'identity_challenge_issued', extra: { challengeExpiresAt: '2026-01-01T01:00:00Z' } },
      { type: 'identity_verified' },
      { type: 'review_started', extra: { actorId: 'operator-1' } },
      { type: 'approved', extra: { actorId: 'operator-1' } },
      { type: 'execution_started' },
      { type: 'execution_completed' },
    ];

    for (const [i, step] of steps.entries()) {
      const outcome = applyTitularRequestEvent(state, {
        type: step.type,
        occurredAt: `2026-01-0${i + 2}T00:00:00Z`,
        version: i + 1,
        ...step.extra,
      });
      expect(outcome.outcome).toBe('applied');
      if (outcome.outcome === 'applied') state = outcome.next;
    }

    expect(state.state.kind).toBe('completed');
  });

  it('rejects an invalid transition (e.g. received -> approved) without applying it', () => {
    const state = initialTitularRequestState('2026-01-01T00:00:00Z');
    const outcome = applyTitularRequestEvent(state, {
      type: 'approved',
      occurredAt: '2026-01-02T00:00:00Z',
      version: 1,
      actorId: 'operator-1',
    });
    expect(outcome.outcome).toBe('rejected_invalid_transition');
    expect(outcome.outcome === 'rejected_invalid_transition' && outcome.current).toEqual(state);
  });

  it('rejects denial without a reasonCode (no silent denial)', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });
    state = applyOrThrow(state, { type: 'identity_verified', occurredAt: '2026-01-03T00:00:00Z', version: 2 });
    state = applyOrThrow(state, {
      type: 'review_started',
      occurredAt: '2026-01-04T00:00:00Z',
      version: 3,
      actorId: 'operator-1',
    });

    const outcome = applyTitularRequestEvent(state, {
      type: 'denied',
      occurredAt: '2026-01-05T00:00:00Z',
      version: 4,
      actorId: 'operator-1',
      // reasonCode ausente de propósito
    });
    expect(outcome.outcome).toBe('rejected_missing_reason');
  });

  it('rejects a reviewer decision without actorId (operator identity is mandatory)', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });
    state = applyOrThrow(state, { type: 'identity_verified', occurredAt: '2026-01-03T00:00:00Z', version: 2 });

    const outcome = applyTitularRequestEvent(state, {
      type: 'review_started',
      occurredAt: '2026-01-04T00:00:00Z',
      version: 3,
    });
    expect(outcome.outcome).toBe('rejected_missing_reason');
  });

  it('treats a re-delivered event (same version) as an idempotent no-op — covers repeated request', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });

    const outcome = applyTitularRequestEvent(state, {
      type: 'identity_challenge_issued',
      occurredAt: '2026-01-02T00:00:00Z',
      version: 1,
    });
    expect(outcome.outcome).toBe('noop_duplicate');
  });

  it('rejects a stale event (older version) without regressing state', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });
    state = applyOrThrow(state, { type: 'identity_verified', occurredAt: '2026-01-03T00:00:00Z', version: 2 });

    const outcome = applyTitularRequestEvent(state, {
      type: 'identity_challenge_issued',
      occurredAt: '2026-01-02T00:00:00Z',
      version: 1,
    });
    expect(outcome.outcome).toBe('rejected_stale');
    expect(state.state.kind).toBe('verified');
  });

  it('identity_rejected (impostor) moves the request to failed, never to verified', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });

    const outcome = applyTitularRequestEvent(state, {
      type: 'identity_rejected',
      occurredAt: '2026-01-03T00:00:00Z',
      version: 2,
      reasonCode: 'identity_proof_mismatch',
    });
    expect(outcome.outcome).toBe('applied');
    expect(outcome.outcome === 'applied' && outcome.next.state.kind).toBe('failed');
  });

  it('identity_expired moves the request to failed with a reason', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });

    const outcome = applyTitularRequestEvent(state, {
      type: 'identity_expired',
      occurredAt: '2026-01-03T00:00:00Z',
      version: 2,
      reasonCode: 'verification_window_elapsed',
    });
    expect(outcome.outcome).toBe('applied');
    expect(outcome.outcome === 'applied' && outcome.next.state.kind).toBe('failed');
  });

  it('partially_denied requires a reasonCode and still allows execution afterwards', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });
    state = applyOrThrow(state, { type: 'identity_verified', occurredAt: '2026-01-03T00:00:00Z', version: 2 });
    state = applyOrThrow(state, {
      type: 'review_started',
      occurredAt: '2026-01-04T00:00:00Z',
      version: 3,
      actorId: 'operator-1',
    });
    state = applyOrThrow(state, {
      type: 'partially_denied',
      occurredAt: '2026-01-05T00:00:00Z',
      version: 4,
      actorId: 'operator-1',
      reasonCode: 'financeiro_retencao_fiscal',
    });
    expect(state.state.kind).toBe('partially_denied');

    const outcome = applyTitularRequestEvent(state, {
      type: 'execution_started',
      occurredAt: '2026-01-06T00:00:00Z',
      version: 5,
    });
    expect(outcome.outcome).toBe('applied');
  });

  it('denied is terminal: no further transition is allowed', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });
    state = applyOrThrow(state, { type: 'identity_verified', occurredAt: '2026-01-03T00:00:00Z', version: 2 });
    state = applyOrThrow(state, {
      type: 'review_started',
      occurredAt: '2026-01-04T00:00:00Z',
      version: 3,
      actorId: 'operator-1',
    });
    state = applyOrThrow(state, {
      type: 'denied',
      occurredAt: '2026-01-05T00:00:00Z',
      version: 4,
      actorId: 'operator-1',
      reasonCode: 'sem_dado_pessoal_identificado',
    });

    const outcome = applyTitularRequestEvent(state, {
      type: 'execution_started',
      occurredAt: '2026-01-06T00:00:00Z',
      version: 5,
    });
    expect(outcome.outcome).toBe('rejected_invalid_transition');
  });

  it('execution_failed requires a reasonCode', () => {
    let state = initialTitularRequestState('2026-01-01T00:00:00Z');
    state = applyOrThrow(state, { type: 'identity_challenge_issued', occurredAt: '2026-01-02T00:00:00Z', version: 1 });
    state = applyOrThrow(state, { type: 'identity_verified', occurredAt: '2026-01-03T00:00:00Z', version: 2 });
    state = applyOrThrow(state, {
      type: 'review_started',
      occurredAt: '2026-01-04T00:00:00Z',
      version: 3,
      actorId: 'operator-1',
    });
    state = applyOrThrow(state, {
      type: 'approved',
      occurredAt: '2026-01-05T00:00:00Z',
      version: 4,
      actorId: 'operator-1',
    });
    state = applyOrThrow(state, { type: 'execution_started', occurredAt: '2026-01-06T00:00:00Z', version: 5 });

    const outcome = applyTitularRequestEvent(state, {
      type: 'execution_failed',
      occurredAt: '2026-01-07T00:00:00Z',
      version: 6,
    });
    expect(outcome.outcome).toBe('rejected_missing_reason');
  });

  describe('stateAllowsDataDisclosure', () => {
    it('never allows disclosure before verified', () => {
      expect(stateAllowsDataDisclosure('received')).toBe(false);
      expect(stateAllowsDataDisclosure('identity_pending')).toBe(false);
    });
    it('allows disclosure from verified onward', () => {
      expect(stateAllowsDataDisclosure('verified')).toBe(true);
      expect(stateAllowsDataDisclosure('in_review')).toBe(true);
      expect(stateAllowsDataDisclosure('approved')).toBe(true);
      expect(stateAllowsDataDisclosure('executing')).toBe(true);
      expect(stateAllowsDataDisclosure('completed')).toBe(true);
    });
    it('never allows disclosure for denied/failed', () => {
      expect(stateAllowsDataDisclosure('denied')).toBe(false);
      expect(stateAllowsDataDisclosure('failed')).toBe(false);
    });
  });
});

function applyOrThrow(
  state: VersionedTitularRequestState,
  event: Parameters<typeof applyTitularRequestEvent>[1],
): VersionedTitularRequestState {
  const outcome = applyTitularRequestEvent(state, event);
  if (outcome.outcome !== 'applied') {
    throw new Error(`expected applied, got ${outcome.outcome}: ${JSON.stringify(outcome)}`);
  }
  return outcome.next;
}
