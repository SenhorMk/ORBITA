/**
 * retentionRunService.test.ts
 * Ticket 18: RED primeiro. Fake de repositório escrito à mão (sem
 * `vi.mock`), mesmo padrão de `titularRequestService.test.ts` (ticket 17).
 */

import { describe, expect, it } from 'vitest';
import { runRetention, type RetentionRunRepositoryPort, type RetentionCandidate } from './retentionRunService';
import type { RetentionEffectAdapter, RetentionItemOutcome, RetentionAction } from './adapters/retentionTypes';

function makeCandidate(overrides: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    entidadeId: 'ent-1',
    entityClockValue: new Date('2026-01-01T00:00:00.000Z'),
    legalHold: false,
    alreadyProcessed: false,
    ...overrides,
  };
}

class FakeRepository implements RetentionRunRepositoryPort {
  runs = new Map<string, { runId: string; status: string }>();
  items = new Map<string, Set<string>>(); // runId -> set of entidadeId marked done
  finalizeCalls: Array<{ runId: string; status: string }> = [];
  candidatesByRun: Record<string, RetentionCandidate[]>;
  private counter = 0;

  constructor(candidates: RetentionCandidate[]) {
    this.candidatesByRun = { default: candidates };
  }

  async startOrGetRun(key: string): Promise<{ runId: string; alreadyExisted: boolean }> {
    const existing = this.runs.get(key);
    if (existing) return { runId: existing.runId, alreadyExisted: true };
    const runId = `run-${++this.counter}`;
    this.runs.set(key, { runId, status: 'running' });
    this.items.set(runId, new Set());
    return { runId, alreadyExisted: false };
  }

  async selectCandidates(runId: string): Promise<RetentionCandidate[]> {
    // Simula `FOR UPDATE SKIP LOCKED`: a seleção já reivindica (claim) o item
    // atomicamente — uma segunda seleção concorrente nunca vê o mesmo item
    // ainda não finalizado.
    const claimed = this.items.get(runId) ?? new Set();
    const result = (this.candidatesByRun.default ?? []).filter((c) => !claimed.has(c.entidadeId));
    for (const c of result) claimed.add(c.entidadeId);
    this.items.set(runId, claimed);
    return result;
  }

  async recordItemOutcome(runId: string, entidadeId: string, status: string): Promise<void> {
    if (status === 'done' || status.startsWith('skipped')) {
      this.items.get(runId)?.add(entidadeId);
    }
  }

  async finalizeRun(runId: string, finalStatus: string): Promise<void> {
    this.finalizeCalls.push({ runId, status: finalStatus });
    const entry = [...this.runs.values()].find((r) => r.runId === runId);
    if (entry) entry.status = finalStatus;
  }
}

function makeAdapter(applyImpl?: (id: string) => Promise<RetentionItemOutcome>): RetentionEffectAdapter & {
  applyCalls: string[];
  previewCalls: string[];
} {
  const applyCalls: string[] = [];
  const previewCalls: string[] = [];
  return {
    sistema: 'banco',
    applyCalls,
    previewCalls,
    async preview(_action: RetentionAction, entidadeId: string) {
      previewCalls.push(entidadeId);
      return { wouldApply: true };
    },
    async apply(_action: RetentionAction, entidadeId: string) {
      applyCalls.push(entidadeId);
      if (applyImpl) return applyImpl(entidadeId);
      return { status: 'done' };
    },
  };
}

const baseParams = {
  organizationId: 'org-1',
  categoria: 'cliente_final_pii',
  policyVersao: 1,
  policyStatus: 'approved' as const,
  prazoDias: 30,
  now: new Date('2026-08-28T00:00:00.000Z'),
  correlationId: 'corr-1',
  action: 'anonymize' as const,
  batchLimit: 50,
};

describe('runRetention — dry-run', () => {
  it('nunca chama adapter.apply em dry-run, só preview', async () => {
    const repo = new FakeRepository([makeCandidate({ entityClockValue: new Date('2026-01-01T00:00:00.000Z') })]);
    const adapter = makeAdapter();
    const result = await runRetention(
      { repository: repo, adapters: [adapter] },
      { ...baseParams, modo: 'dry_run' },
    );
    expect(adapter.applyCalls).toEqual([]);
    expect(adapter.previewCalls).toEqual(['ent-1']);
    expect(result.selected).toBe(1);
    expect(result.finalStatus).toBe('completed');
  });
});

describe('runRetention — execute', () => {
  it('chama adapter.apply apenas para itens elegíveis (respeita cutoff/legal hold/já processado)', async () => {
    const repo = new FakeRepository([
      makeCandidate({ entidadeId: 'elegivel', entityClockValue: new Date('2026-01-01T00:00:00.000Z') }),
      makeCandidate({ entidadeId: 'antes-do-cutoff', entityClockValue: new Date('2026-08-27T00:00:00.000Z') }),
      makeCandidate({ entidadeId: 'com-hold', entityClockValue: new Date('2026-01-01T00:00:00.000Z'), legalHold: true }),
      makeCandidate({ entidadeId: 'ja-processado', entityClockValue: new Date('2026-01-01T00:00:00.000Z'), alreadyProcessed: true }),
    ]);
    const adapter = makeAdapter();
    const result = await runRetention(
      { repository: repo, adapters: [adapter] },
      { ...baseParams, modo: 'execute' },
    );
    expect(adapter.applyCalls).toEqual(['elegivel']);
    expect(result.processed).toBe(1);
    expect(result.skippedLegalHold).toBe(1);
    expect(result.skippedAlreadyProcessed).toBe(1);
    expect(result.skippedBeforeCutoff).toBe(1);
    expect(result.finalStatus).toBe('completed');
  });

  it('falha parcial nunca marca o run como completed — vira completed_with_errors', async () => {
    const repo = new FakeRepository([
      makeCandidate({ entidadeId: 'ok', entityClockValue: new Date('2026-01-01T00:00:00.000Z') }),
      makeCandidate({ entidadeId: 'falha', entityClockValue: new Date('2026-01-01T00:00:00.000Z') }),
    ]);
    const adapter = makeAdapter(async (id) =>
      id === 'falha' ? { status: 'failed', erro: 'boom' } : { status: 'done' },
    );
    const result = await runRetention(
      { repository: repo, adapters: [adapter] },
      { ...baseParams, modo: 'execute' },
    );
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.finalStatus).toBe('completed_with_errors');
    expect(repo.finalizeCalls.at(-1)?.status).toBe('completed_with_errors');
  });

  it('política pending_approval nunca aplica efeito, mesmo em modo execute (needs-owner até aprovação)', async () => {
    const repo = new FakeRepository([makeCandidate({ entityClockValue: new Date('2026-01-01T00:00:00.000Z') })]);
    const adapter = makeAdapter();
    const result = await runRetention(
      { repository: repo, adapters: [adapter] },
      { ...baseParams, modo: 'execute', policyStatus: 'pending_approval' },
    );
    expect(adapter.applyCalls).toEqual([]);
    expect(result.skippedPolicyNotApproved).toBe(1);
    expect(result.processed).toBe(0);
  });

  it('idempotência: reexecutar a mesma run (mesma key) não duplica efeito sobre item já done', async () => {
    const repo = new FakeRepository([makeCandidate({ entityClockValue: new Date('2026-01-01T00:00:00.000Z') })]);
    const adapter = makeAdapter();
    const first = await runRetention({ repository: repo, adapters: [adapter] }, { ...baseParams, modo: 'execute' });
    const second = await runRetention({ repository: repo, adapters: [adapter] }, { ...baseParams, modo: 'execute' });
    expect(first.runId).toBe(second.runId);
    expect(adapter.applyCalls).toEqual(['ent-1']); // não chamou de novo na segunda passada
    expect(second.selected).toBe(0);
  });

  it('duas "execuções concorrentes" (mesmos parâmetros, repositório compartilhado) convergem no mesmo runId', async () => {
    const repo = new FakeRepository([makeCandidate({ entityClockValue: new Date('2026-01-01T00:00:00.000Z') })]);
    const adapterA = makeAdapter();
    const adapterB = makeAdapter();
    const [resultA, resultB] = await Promise.all([
      runRetention({ repository: repo, adapters: [adapterA] }, { ...baseParams, modo: 'execute' }),
      runRetention({ repository: repo, adapters: [adapterB] }, { ...baseParams, modo: 'execute' }),
    ]);
    expect(resultA.runId).toBe(resultB.runId);
    // Exatamente um dos dois adapters processou o item (o outro viu 0 selecionado
    // porque `startOrGetRun` é síncrono/idempotente no fake e a segunda chamada de
    // `selectCandidates` já não retorna o item recém-marcado).
    const totalApplyCalls = adapterA.applyCalls.length + adapterB.applyCalls.length;
    expect(totalApplyCalls).toBe(1);
  });
});

describe('runRetention — A/B (duas organizações isoladas)', () => {
  it('cada organização usa sua própria chave de run — nunca compartilha runId entre tenants', async () => {
    const repo = new FakeRepository([makeCandidate({ entityClockValue: new Date('2026-01-01T00:00:00.000Z') })]);
    const adapter = makeAdapter();
    const resultOrgA = await runRetention(
      { repository: repo, adapters: [adapter] },
      { ...baseParams, organizationId: 'org-a', modo: 'execute' },
    );
    const resultOrgB = await runRetention(
      { repository: repo, adapters: [adapter] },
      { ...baseParams, organizationId: 'org-b', modo: 'execute' },
    );
    expect(resultOrgA.runId).not.toBe(resultOrgB.runId);
  });
});
