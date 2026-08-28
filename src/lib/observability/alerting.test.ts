import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryAlertSink,
  evaluateAuthFailureBurst,
  evaluateCrossTenantAttempt,
  evaluateInvalidWebhookSignature,
  evaluateDeadLetter,
  evaluateMigrationReadiness,
  evaluateOwnerOrBillingChange,
  dispatchAlerts,
  type RawAuditEventForAlerting,
} from './alerting';

function evt(overrides: Partial<RawAuditEventForAlerting> = {}): RawAuditEventForAlerting {
  return {
    acao: 'auth.login_failed',
    organizacaoId: 'org-1',
    actorId: 'user-1',
    correlationId: 'corr_1',
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

describe('alerting', () => {
  let sink: InMemoryAlertSink;

  beforeEach(() => {
    sink = new InMemoryAlertSink();
  });

  it('authFailureBurst não dispara com uma única falha de login', () => {
    const alerts = evaluateAuthFailureBurst([evt({ acao: 'auth.login_failed' })]);
    expect(alerts).toHaveLength(0);
  });

  it('authFailureBurst dispara quando o mesmo ator/organização falha 5+ vezes em janela curta', () => {
    const now = Date.now();
    const events = Array.from({ length: 5 }, (_, i) =>
      evt({
        acao: 'auth.login_failed',
        actorId: 'user-attacker',
        organizacaoId: 'org-1',
        createdAt: new Date(now + i * 1000).toISOString(),
      }),
    );
    const alerts = evaluateAuthFailureBurst(events);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule).toBe('authFailureBurst');
    expect(alerts[0].severity).toBe('critical');
  });

  it('crossTenantAttempt dispara para qualquer evento security.cross_tenant_attempt', () => {
    const alerts = evaluateCrossTenantAttempt([
      evt({ acao: 'auth.login_success' }),
      evt({ acao: 'security.cross_tenant_attempt', organizacaoId: 'org-vitima' }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule).toBe('crossTenantAttempt');
    expect(alerts[0].severity).toBe('critical');
  });

  it('invalidWebhookSignature dispara para webhook.signature_invalid', () => {
    const alerts = evaluateInvalidWebhookSignature([
      evt({ acao: 'webhook.signature_invalid', metadata: { provider: 'bling' } }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule).toBe('invalidWebhookSignature');
  });

  it('deadLetter dispara para job.dead_letter', () => {
    const alerts = evaluateDeadLetter([evt({ acao: 'job.dead_letter' })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule).toBe('deadLetter');
  });

  it('migrationReadiness dispara para org.migration_readiness_failed', () => {
    const alerts = evaluateMigrationReadiness([evt({ acao: 'org.migration_readiness_failed', organizacaoId: null })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule).toBe('migrationReadiness');
  });

  it('ownerOrBillingChange dispara para billing.owner_changed e billing.plan_changed', () => {
    const alerts = evaluateOwnerOrBillingChange([
      evt({ acao: 'billing.owner_changed' }),
      evt({ acao: 'billing.plan_changed' }),
      evt({ acao: 'auth.login_success' }),
    ]);
    expect(alerts).toHaveLength(2);
  });

  it('dispatchAlerts envia cada alerta ao sink controlado e o sink acumula os recebidos', async () => {
    const events = [evt({ acao: 'job.dead_letter' }), evt({ acao: 'security.cross_tenant_attempt' })];
    await dispatchAlerts(sink, events);

    expect(sink.received).toHaveLength(2);
    expect(sink.received.map((a) => a.rule).sort()).toEqual(['crossTenantAttempt', 'deadLetter']);
  });

  it('dispatchAlerts não duplica quando nenhuma regra dispara', async () => {
    await dispatchAlerts(sink, [evt({ acao: 'auth.login_success' })]);
    expect(sink.received).toHaveLength(0);
  });
});
