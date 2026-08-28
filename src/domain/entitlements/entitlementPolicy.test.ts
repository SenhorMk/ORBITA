import { describe, expect, it } from 'vitest';
import { evaluateEntitlementPolicy, type EntitlementLimitsSnapshot, type ResourceUsageSnapshot } from './entitlementPolicy';
import type { SubscriptionLifecycleState } from './subscriptionLifecycle';

const starterLimits: EntitlementLimitsSnapshot = {
  limite_membros: 3,
  limite_conexoes_bling: 1,
  limite_conexoes_chatwoot: 1,
  recursos: { export_relatorios: false },
};

const proLimits: EntitlementLimitsSnapshot = {
  limite_membros: 10,
  limite_conexoes_bling: 3,
  limite_conexoes_chatwoot: 3,
  recursos: { export_relatorios: true },
};

function usage(membros: number): ResourceUsageSnapshot {
  return { membros, conexoes_bling: 0, conexoes_chatwoot: 0 };
}

describe('Ticket 13: entitlementPolicy (matriz de bloqueio única)', () => {
  const active: SubscriptionLifecycleState = { kind: 'active', since: '2026-08-01T00:00:00.000Z' };
  const suspended: SubscriptionLifecycleState = { kind: 'suspended', since: '2026-08-01T00:00:00.000Z', reason: 'Inadimplencia' };
  const cancelled: SubscriptionLifecycleState = { kind: 'cancelled', since: '2026-08-01T00:00:00.000Z' };
  const pendingDeletion: SubscriptionLifecycleState = {
    kind: 'pending_deletion',
    since: '2026-08-01T00:00:00.000Z',
    scheduledFor: '2026-09-01T00:00:00.000Z',
  };
  const pastDue: SubscriptionLifecycleState = { kind: 'past_due', since: '2026-08-01T00:00:00.000Z' };
  const trial: SubscriptionLifecycleState = { kind: 'trial', since: '2026-08-01T00:00:00.000Z' };

  it('permite mutação em trial/active/past_due dentro do limite (plano starter, org A)', () => {
    for (const state of [trial, active, pastDue]) {
      const decision = evaluateEntitlementPolicy(
        state,
        { category: 'resource_mutation', name: 'convidar_membro', limitedResource: 'membros' },
        starterLimits,
        usage(1),
      );
      expect(decision.allowed).toBe(true);
    }
  });

  it('bloqueia mutação quando suspenso/cancelado/pending_deletion, mesmo dentro do limite numérico', () => {
    for (const state of [suspended, cancelled, pendingDeletion]) {
      const decision = evaluateEntitlementPolicy(
        state,
        { category: 'resource_mutation', name: 'convidar_membro', limitedResource: 'membros' },
        proLimits,
        usage(0),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe('LIFECYCLE_BLOCKED');
    }
  });

  it('nunca bloqueia leitura ou exportação, mesmo suspenso ou pending_deletion (LGPD)', () => {
    for (const state of [suspended, cancelled, pendingDeletion]) {
      const readDecision = evaluateEntitlementPolicy(
        state,
        { category: 'read', name: 'listar_pedidos' },
        proLimits,
        usage(0),
      );
      const exportDecision = evaluateEntitlementPolicy(
        state,
        { category: 'export', name: 'exportar_dados_lgpd' },
        proLimits,
        usage(0),
      );
      expect(readDecision.allowed).toBe(true);
      expect(exportDecision.allowed).toBe(true);
    }
  });

  it('bloqueia por LIMIT_EXCEEDED quando contagem atinge o limite do plano starter (org A) mas não do pro (org B)', () => {
    const orgAStarterAtLimit = evaluateEntitlementPolicy(
      active,
      { category: 'resource_mutation', name: 'convidar_membro', limitedResource: 'membros' },
      starterLimits,
      usage(3),
    );
    const orgBProSameCount = evaluateEntitlementPolicy(
      active,
      { category: 'resource_mutation', name: 'convidar_membro', limitedResource: 'membros' },
      proLimits,
      usage(3),
    );

    expect(orgAStarterAtLimit.allowed).toBe(false);
    if (!orgAStarterAtLimit.allowed) expect(orgAStarterAtLimit.code).toBe('LIMIT_EXCEEDED');
    expect(orgBProSameCount.allowed).toBe(true);
  });

  it('bloqueia por FEATURE_NOT_INCLUDED quando o plano não inclui o recurso booleano', () => {
    const decision = evaluateEntitlementPolicy(
      active,
      { category: 'resource_mutation', name: 'exportar_relatorio_avancado', requiredFeature: 'export_relatorios' },
      starterLimits,
      usage(0),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('FEATURE_NOT_INCLUDED');
  });

  it('lifecycle é checado antes do limite numérico (bloqueio por estado tem prioridade)', () => {
    const decision = evaluateEntitlementPolicy(
      suspended,
      { category: 'resource_mutation', name: 'convidar_membro', limitedResource: 'membros' },
      proLimits,
      usage(9999),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('LIFECYCLE_BLOCKED');
  });
});
