import { describe, expect, it } from 'vitest';
import {
  applyLifecycleEvent,
  initialLifecycleState,
  type VersionedLifecycleState,
} from './subscriptionLifecycle';

describe('Ticket 13: subscriptionLifecycle (máquina de estados pura)', () => {
  it('transição válida: trial -> active via evento "activated"', () => {
    const current = initialLifecycleState('2026-08-01T00:00:00.000Z');

    const outcome = applyLifecycleEvent(current, {
      type: 'activated',
      occurredAt: '2026-08-02T00:00:00.000Z',
      version: 1,
    });

    expect(outcome.outcome).toBe('applied');
    if (outcome.outcome === 'applied') {
      expect(outcome.next.state.kind).toBe('active');
      expect(outcome.next.version).toBe(1);
    }
  });

  it('transição válida: active -> suspended via evento "suspended" preserva motivo', () => {
    const active: VersionedLifecycleState = {
      state: { kind: 'active', since: '2026-08-01T00:00:00.000Z' },
      appliedAt: '2026-08-01T00:00:00.000Z',
      version: 1,
    };

    const outcome = applyLifecycleEvent(active, {
      type: 'suspended',
      occurredAt: '2026-08-10T00:00:00.000Z',
      version: 2,
      reason: 'Inadimplencia Stripe',
    });

    expect(outcome.outcome).toBe('applied');
    if (outcome.outcome === 'applied' && outcome.next.state.kind === 'suspended') {
      expect(outcome.next.state.reason).toBe('Inadimplencia Stripe');
    }
  });

  it('transição inválida: pending_deletion não aceita "activated" diretamente', () => {
    const pendingDeletion: VersionedLifecycleState = {
      state: { kind: 'pending_deletion', since: '2026-08-01T00:00:00.000Z', scheduledFor: '2026-09-01T00:00:00.000Z' },
      appliedAt: '2026-08-01T00:00:00.000Z',
      version: 3,
    };

    const outcome = applyLifecycleEvent(pendingDeletion, {
      type: 'activated',
      occurredAt: '2026-08-05T00:00:00.000Z',
      version: 4,
    });

    expect(outcome.outcome).toBe('rejected_invalid_transition');
    if (outcome.outcome === 'rejected_invalid_transition') {
      expect(outcome.current.state.kind).toBe('pending_deletion');
    }
  });

  it('transição inválida: cancelled não aceita "suspended" (matriz explícita não permite)', () => {
    const cancelled: VersionedLifecycleState = {
      state: { kind: 'cancelled', since: '2026-08-01T00:00:00.000Z' },
      appliedAt: '2026-08-01T00:00:00.000Z',
      version: 5,
    };

    const outcome = applyLifecycleEvent(cancelled, {
      type: 'suspended',
      occurredAt: '2026-08-05T00:00:00.000Z',
      version: 6,
      reason: 'tentativa invalida',
    });

    expect(outcome.outcome).toBe('rejected_invalid_transition');
  });

  it('transição repetida: reentrega do mesmo evento (mesma versão) é idempotente (noop_duplicate)', () => {
    const active: VersionedLifecycleState = {
      state: { kind: 'active', since: '2026-08-01T00:00:00.000Z' },
      appliedAt: '2026-08-01T00:00:00.000Z',
      version: 7,
    };

    const outcome = applyLifecycleEvent(active, {
      type: 'payment_failed',
      occurredAt: '2026-08-01T00:00:00.000Z',
      version: 7,
    });

    expect(outcome.outcome).toBe('noop_duplicate');
    if (outcome.outcome === 'noop_duplicate') {
      expect(outcome.current.state.kind).toBe('active');
    }
  });

  it('evento fora de ordem (versão anterior) nunca regride o estado já aplicado', () => {
    const suspended: VersionedLifecycleState = {
      state: { kind: 'suspended', since: '2026-08-10T00:00:00.000Z', reason: 'Inadimplencia' },
      appliedAt: '2026-08-10T00:00:00.000Z',
      version: 10,
    };

    const staleEvent = applyLifecycleEvent(suspended, {
      type: 'activated',
      occurredAt: '2026-08-02T00:00:00.000Z',
      version: 4,
    });

    expect(staleEvent.outcome).toBe('rejected_stale');
    if (staleEvent.outcome === 'rejected_stale') {
      expect(staleEvent.current.state.kind).toBe('suspended');
      expect(staleEvent.current.version).toBe(10);
    }
  });

  it('evento fora de ordem por timestamp (mesma versão numérica indisponível, timestamp antigo) é rejeitado', () => {
    const active: VersionedLifecycleState = {
      state: { kind: 'active', since: '2026-08-10T00:00:00.000Z' },
      appliedAt: '2026-08-10T00:00:00.000Z',
      version: 20,
    };

    const outcome = applyLifecycleEvent(active, {
      type: 'suspended',
      occurredAt: '2026-08-01T00:00:00.000Z',
      version: 21,
      reason: 'replay antigo',
    });

    expect(outcome.outcome).toBe('rejected_stale');
  });

  it('cadeia completa A/B: duas organizações com planos/estados distintos não interferem entre si', () => {
    const orgAActive: VersionedLifecycleState = {
      state: { kind: 'active', since: '2026-08-01T00:00:00.000Z' },
      appliedAt: '2026-08-01T00:00:00.000Z',
      version: 1,
    };
    const orgBSuspended: VersionedLifecycleState = {
      state: { kind: 'suspended', since: '2026-08-01T00:00:00.000Z', reason: 'Inadimplencia' },
      appliedAt: '2026-08-01T00:00:00.000Z',
      version: 5,
    };

    const orgAOutcome = applyLifecycleEvent(orgAActive, {
      type: 'payment_failed',
      occurredAt: '2026-08-05T00:00:00.000Z',
      version: 2,
    });
    const orgBOutcome = applyLifecycleEvent(orgBSuspended, {
      type: 'reactivated',
      occurredAt: '2026-08-05T00:00:00.000Z',
      version: 6,
    });

    expect(orgAOutcome.outcome).toBe('applied');
    expect(orgBOutcome.outcome).toBe('applied');
    if (orgAOutcome.outcome === 'applied') expect(orgAOutcome.next.state.kind).toBe('past_due');
    if (orgBOutcome.outcome === 'applied') expect(orgBOutcome.next.state.kind).toBe('active');
  });
});
