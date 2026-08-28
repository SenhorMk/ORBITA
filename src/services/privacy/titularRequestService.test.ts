import { describe, expect, it } from 'vitest';
import { initialTitularRequestState, applyTitularRequestEvent, type VersionedTitularRequestState } from '@/domain/privacy/titularRequestStateMachine';
import { decideTitularRequest, executeTitularRequest, type TitularRequestRecord, type TitularRequestRepositoryPort } from './titularRequestService';
import type { AdapterOutcome, TarefaSistema, TitularSystemAdapter } from './adapters/types';

class FakeTitularRequestRepository implements TitularRequestRepositoryPort {
  records = new Map<string, TitularRequestRecord>();
  savedTransitions: Array<{ id: string; next: VersionedTitularRequestState }> = [];
  recordedTasks: Array<{ requestId: string; sistema: TarefaSistema; outcome: AdapterOutcome }> = [];

  async findById(id: string) {
    return this.records.get(id) ?? null;
  }
  async saveTransition(id: string, next: VersionedTitularRequestState) {
    this.savedTransitions.push({ id, next });
    const existing = this.records.get(id);
    if (existing) this.records.set(id, { ...existing, state: next });
  }
  async recordTaskOutcome(requestId: string, sistema: TarefaSistema, outcome: AdapterOutcome) {
    this.recordedTasks.push({ requestId, sistema, outcome });
  }
}

function verifiedStateAt(version: number): VersionedTitularRequestState {
  let state = initialTitularRequestState('2026-01-01T00:00:00Z');
  const steps: Array<{ type: 'identity_challenge_issued' | 'identity_verified'; extra?: Record<string, unknown> }> = [
    { type: 'identity_challenge_issued' },
    { type: 'identity_verified' },
  ];
  for (const [i, step] of steps.slice(0, version).entries()) {
    const outcome = applyTitularRequestEvent(state, {
      type: step.type,
      occurredAt: `2026-01-0${i + 2}T00:00:00Z`,
      version: i + 1,
      ...step.extra,
    });
    if (outcome.outcome !== 'applied') throw new Error('setup failed');
    state = outcome.next;
  }
  return state;
}

function baseRecord(overrides: Partial<TitularRequestRecord> = {}): TitularRequestRecord {
  return {
    id: 'req-1',
    organizationId: 'org-a',
    titularTipo: 'cliente_final',
    titularRefUserId: null,
    titularRefClienteId: 'cliente-1',
    tipoDireito: 'acesso',
    state: verifiedStateAt(2), // 'verified'
    ...overrides,
  };
}

describe('decideTitularRequest', () => {
  it('denies a member without organization:manage capability (membro sem capability)', async () => {
    const repo = new FakeTitularRequestRepository();
    repo.records.set('req-1', baseRecord());

    const outcome = await decideTitularRequest(
      { repository: repo },
      {
        requestId: 'req-1',
        operator: { organizationId: 'org-a', actorId: 'member-1', hasManageCapability: false },
        decision: 'review_started',
        occurredAt: '2026-01-03T00:00:00Z',
        correlationId: 'corr-1',
      },
    );

    expect(outcome).toEqual({ _tag: 'Denied', reason: 'not_authorized' });
    expect(repo.savedTransitions).toHaveLength(0);
  });

  it('allows an authorized owner/admin to move the request forward (owner autorizado)', async () => {
    const repo = new FakeTitularRequestRepository();
    repo.records.set('req-1', baseRecord());

    const outcome = await decideTitularRequest(
      { repository: repo },
      {
        requestId: 'req-1',
        operator: { organizationId: 'org-a', actorId: 'owner-1', hasManageCapability: true },
        decision: 'review_started',
        occurredAt: '2026-01-03T00:00:00Z',
        correlationId: 'corr-1',
      },
    );

    expect(outcome._tag).toBe('Applied');
    expect(repo.savedTransitions).toHaveLength(1);
  });

  it('denies (as not-found, never confirming existence) an operator from another organization (cross-tenant)', async () => {
    const repo = new FakeTitularRequestRepository();
    repo.records.set('req-1', baseRecord({ organizationId: 'org-a' }));

    const outcome = await decideTitularRequest(
      { repository: repo },
      {
        requestId: 'req-1',
        operator: { organizationId: 'org-b', actorId: 'owner-b', hasManageCapability: true },
        decision: 'review_started',
        occurredAt: '2026-01-03T00:00:00Z',
        correlationId: 'corr-1',
      },
    );

    expect(outcome).toEqual({ _tag: 'Denied', reason: 'cross_tenant' });
    expect(repo.savedTransitions).toHaveLength(0);
  });

  it('propagates an invalid transition from the domain state machine (transicao invalida)', async () => {
    const repo = new FakeTitularRequestRepository();
    // 'verified' does not allow 'approved' directly (must go through in_review).
    repo.records.set('req-1', baseRecord());

    const outcome = await decideTitularRequest(
      { repository: repo },
      {
        requestId: 'req-1',
        operator: { organizationId: 'org-a', actorId: 'owner-1', hasManageCapability: true },
        decision: 'approved',
        reasonCode: undefined,
        occurredAt: '2026-01-03T00:00:00Z',
        correlationId: 'corr-1',
      },
    );

    expect(outcome._tag).toBe('RejectedByStateMachine');
    expect(repo.savedTransitions).toHaveLength(0);
  });
});

class StubAdapter implements TitularSystemAdapter {
  constructor(readonly sistema: TarefaSistema, private readonly outcome: AdapterOutcome | (() => AdapterOutcome)) {}
  async execute(): Promise<AdapterOutcome> {
    return typeof this.outcome === 'function' ? this.outcome() : this.outcome;
  }
}

class ThrowingAdapter implements TitularSystemAdapter {
  readonly sistema: TarefaSistema = 'bling';
  async execute(): Promise<AdapterOutcome> {
    throw new Error('provider indisponivel');
  }
}

describe('executeTitularRequest', () => {
  it('runs every adapter and never hides a failing system, even when others succeed', async () => {
    const repo = new FakeTitularRequestRepository();
    const record = baseRecord();

    const result = await executeTitularRequest(
      { repository: repo },
      {
        request: record,
        adapters: [
          new StubAdapter('banco', { status: 'completed' }),
          new StubAdapter('chatwoot', { status: 'retryable', motivo: 'aguardando outbox' }),
          new StubAdapter('logs', { status: 'not_found' }),
        ],
        correlationId: 'corr-1',
      },
    );

    expect(result.summary.map((s) => s.sistema)).toEqual(['banco', 'chatwoot', 'logs']);
    expect(result.finalState).toBe('failed'); // chatwoot ainda retryable -> nunca completed prematuro
    expect(repo.recordedTasks).toHaveLength(3);
  });

  it('reaches completed only when every system is completed/not_found/retained_with_reason', async () => {
    const repo = new FakeTitularRequestRepository();
    const record = baseRecord();

    const result = await executeTitularRequest(
      { repository: repo },
      {
        request: record,
        adapters: [
          new StubAdapter('banco', { status: 'completed' }),
          new StubAdapter('logs', { status: 'retained_with_reason', fundamento: 'trilha_auditoria_integridade_obrigatoria' }),
          new StubAdapter('stripe', { status: 'not_found' }),
        ],
        correlationId: 'corr-1',
      },
    );

    expect(result.finalState).toBe('completed');
  });

  it('turns an unexpected adapter exception into a recorded failed outcome (no empty catch, no fake success)', async () => {
    const repo = new FakeTitularRequestRepository();
    const record = baseRecord();

    const result = await executeTitularRequest(
      { repository: repo },
      { request: record, adapters: [new ThrowingAdapter()], correlationId: 'corr-1' },
    );

    expect(result.finalState).toBe('failed');
    expect(result.summary[0].outcome).toEqual({ status: 'failed', erro: 'provider indisponivel' });
    expect(repo.recordedTasks[0]).toEqual({
      requestId: 'req-1',
      sistema: 'bling',
      outcome: { status: 'failed', erro: 'provider indisponivel' },
    });
  });
});
