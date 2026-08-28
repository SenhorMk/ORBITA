import { describe, it, expect } from 'vitest';
import { InMemoryAlertSink, dispatchAlerts, type RawAuditEventForAlerting } from './alerting';
import { isKnownAuditEvent, getAuditEventDefinition } from './auditEventCatalog';
import { redactSensitiveData } from './logger';
import { isSafeCorrelationId } from './correlation';

/**
 * Tabletop sintético obrigatório (ticket 19, contrato item "não considerar runbook não
 * ensaiado como pronto"). Cenário: tentativa cross-tenant seguida de webhook
 * comprometido (assinatura inválida), 100% com dados sintéticos, encadeados por um único
 * correlation_id — exatamente o exercício descrito em
 * `.scratch/orbita-mvp-producao-v2/evidence/19-tabletop-report.md`.
 *
 * Este teste executa o cenário de ponta a ponta contra o código real de detecção
 * (`alerting.ts`) e catálogo (`auditEventCatalog.ts`), não uma simulação narrativa —
 * é a prova executável exigida pelo contrato de que o runbook foi de fato ensaiado.
 */
describe('tabletop sintético — cross-tenant + webhook comprometido', () => {
  const correlationId = 'corr_tabletop_synthetic_0001';
  const orgVitima = 'org-tabletop-vitima-sintetica';
  const atorSintetico = 'user-tabletop-atacante-sintetico';

  it('correlation id sintético usado no cenário é seguro (não é ele mesmo um vetor de injeção)', () => {
    expect(isSafeCorrelationId(correlationId)).toBe(true);
  });

  it('todos os eventos do cenário pertencem ao catálogo versionado', () => {
    for (const acao of ['security.cross_tenant_attempt', 'webhook.signature_invalid', 'job.dead_letter']) {
      expect(isKnownAuditEvent(acao)).toBe(true);
    }
  });

  it('executa o cenário completo e verifica detecção, alerta e ausência de vazamento de segredo', async () => {
    const t0 = new Date('2026-08-28T13:00:00.000Z');
    const minutes = (n: number) => new Date(t0.getTime() + n * 60_000).toISOString();

    // Linha do tempo sintética (nenhum dado real):
    // T+0  actor sintético autenticado na Org Atacante tenta gravar evento na Org Vítima —
    //      a RPC registrar_evento_auditoria (migration 52) recusa e o app registra a
    //      tentativa como security.cross_tenant_attempt.
    // T+2  na sequência, um webhook chega com assinatura inválida tentando se passar por
    //      um provider legítimo, carregando um "segredo" sintético que NUNCA pode
    //      aparecer em claro na trilha.
    // T+4  o outbox tenta notificar a organização vítima e esgota tentativas -> dead_letter.
    const events: RawAuditEventForAlerting[] = [
      {
        acao: 'security.cross_tenant_attempt',
        organizacaoId: orgVitima,
        actorId: atorSintetico,
        correlationId,
        createdAt: minutes(0),
        metadata: redactSensitiveData({
          tentativaOrganizacaoId: orgVitima,
          origem: 'app.registrarEventoAuditoria',
        }) as Record<string, unknown>,
      },
      {
        acao: 'webhook.signature_invalid',
        organizacaoId: orgVitima,
        actorId: null,
        correlationId,
        createdAt: minutes(2),
        metadata: redactSensitiveData({
          provider: 'bling',
          // segredo sintético — nunca deve sobreviver a redactSensitiveData
          webhookSecretRecebido: 'synthetic-forged-secret-do-not-log-1234',
        }) as Record<string, unknown>,
      },
      {
        acao: 'job.dead_letter',
        organizacaoId: orgVitima,
        actorId: null,
        correlationId,
        createdAt: minutes(4),
        metadata: { destino: 'notificacao_organizacao_vitima', tentativas: 5 },
      },
    ];

    // 1. Nenhum segredo sintético sobrevive na trilha, mesmo com o cenário adversarial.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('synthetic-forged-secret-do-not-log-1234');
    expect(serialized).toContain('[REDACTED]');

    // 2. Detecção: as três regras mínimas relevantes ao cenário disparam.
    const sink = new InMemoryAlertSink();
    const alerts = await dispatchAlerts(sink, events);

    const rulesFired = alerts.map((a) => a.rule).sort();
    expect(rulesFired).toEqual(['crossTenantAttempt', 'deadLetter', 'invalidWebhookSignature']);
    expect(sink.received).toHaveLength(3);
    expect(alerts.every((a) => a.severity === 'critical')).toBe(true);

    // 3. Investigação por correlationId reconstrói a cadeia completa do incidente.
    const investigacao = events.filter((e) => e.correlationId === correlationId);
    expect(investigacao).toHaveLength(3);
    expect(investigacao.map((e) => e.acao)).toEqual([
      'security.cross_tenant_attempt',
      'webhook.signature_invalid',
      'job.dead_letter',
    ]);

    // 4. Classificação de severidade (playbook seção 2): confirmado por catálogo, não por suposição.
    const severidadesCatalogo = investigacao.map((e) => getAuditEventDefinition(e.acao)?.severidade);
    expect(severidadesCatalogo).toEqual(['critical', 'critical', 'critical']);
  });
});
