import { logStructured } from './logger';

/**
 * Métricas/alertas de segurança e operação (ticket 19).
 *
 * Não existe ambiente de staging/produção implantado neste projeto ainda — a entrega
 * real de alerta em staging fica `needs-owner` (ver
 * `.scratch/orbita-mvp-producao-v2/evidence/19-final-evidence.md`). O que É testável e
 * executável agora: as regras de avaliação (puras, determinísticas) e um sink
 * controlado/local que qualquer implementação futura de sink real (Slack, PagerDuty,
 * e-mail) só precisa satisfazer via a interface `AlertSink`.
 */

export type AlertRuleName =
  | 'authFailureBurst'
  | 'crossTenantAttempt'
  | 'invalidWebhookSignature'
  | 'deadLetter'
  | 'migrationReadiness'
  | 'ownerOrBillingChange';

export type AlertSeverity = 'warning' | 'critical';

export interface AlertEvent {
  readonly rule: AlertRuleName;
  readonly severity: AlertSeverity;
  readonly summary: string;
  readonly organizacaoId: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
  /** Contexto adicional já sanitizado — nunca inclui payload bruto/segredo. */
  readonly context: Record<string, unknown>;
}

/**
 * Sink de entrega de alertas. Uma implementação real (Slack, PagerDuty, e-mail) troca
 * apenas `send`; as regras e o orquestrador (`dispatchAlerts`) não mudam.
 */
export interface AlertSink {
  send(alert: AlertEvent): Promise<void>;
}

/** Sink controlado/local para testes e para o tabletop sintético. */
export class InMemoryAlertSink implements AlertSink {
  readonly received: AlertEvent[] = [];

  async send(alert: AlertEvent): Promise<void> {
    this.received.push(alert);
  }
}

/**
 * Sink local "real" (não staging): emite o alerta como log estruturado crítico, sempre
 * disponível mesmo sem nenhum provedor externo configurado. Serve de base para compor
 * um sink real de staging (ex.: encadear com um webhook do Slack) sem trocar as regras.
 */
export class StructuredLogAlertSink implements AlertSink {
  async send(alert: AlertEvent): Promise<void> {
    logStructured(alert.severity === 'critical' ? 'error' : 'warn', `[ALERT] ${alert.summary}`, {
      subsystem: 'app',
      correlationId: alert.correlationId ?? undefined,
      organizacaoId: alert.organizacaoId ?? undefined,
      rule: alert.rule,
      ...alert.context,
    });
  }
}

/** Forma mínima de um evento de auditoria necessária para avaliar regras de alerta. */
export interface RawAuditEventForAlerting {
  readonly acao: string;
  readonly organizacaoId: string | null;
  readonly actorId: string | null;
  readonly correlationId: string | null;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

const AUTH_FAILURE_BURST_THRESHOLD = 5;
const AUTH_FAILURE_BURST_WINDOW_MS = 5 * 60 * 1000;

/** Burst de falha de autenticação: N+ `auth.login_failed` do mesmo ator/organização numa janela curta. */
export function evaluateAuthFailureBurst(events: readonly RawAuditEventForAlerting[]): AlertEvent[] {
  const failures = events.filter((e) => e.acao === 'auth.login_failed');
  const byKey = new Map<string, RawAuditEventForAlerting[]>();
  for (const e of failures) {
    const key = `${e.organizacaoId ?? 'unknown'}::${e.actorId ?? 'unknown'}`;
    const list = byKey.get(key) ?? [];
    list.push(e);
    byKey.set(key, list);
  }

  const alerts: AlertEvent[] = [];
  for (const [, list] of byKey) {
    const sorted = [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const windowStart = Date.parse(sorted[0].createdAt);
    const windowEnd = Date.parse(sorted[sorted.length - 1].createdAt);
    if (sorted.length >= AUTH_FAILURE_BURST_THRESHOLD && windowEnd - windowStart <= AUTH_FAILURE_BURST_WINDOW_MS) {
      const last = sorted[sorted.length - 1];
      alerts.push({
        rule: 'authFailureBurst',
        severity: 'critical',
        summary: `Burst de ${sorted.length} falhas de autenticação em janela curta`,
        organizacaoId: last.organizacaoId,
        correlationId: last.correlationId,
        occurredAt: last.createdAt,
        context: { count: sorted.length, actorId: last.actorId },
      });
    }
  }
  return alerts;
}

/**
 * Constrói um `AlertEvent` a partir do evento de origem, com os campos de correlação
 * (organização/correlationId/timestamp) sempre extraídos do mesmo lugar — as seis regras
 * de alerta só variam em predicado, severidade e resumo, não nessa extração.
 */
function toAlert(
  e: RawAuditEventForAlerting,
  rule: AlertRuleName,
  severity: AlertSeverity,
  summary: string,
  context: Record<string, unknown> = {},
): AlertEvent {
  return {
    rule,
    severity,
    summary,
    organizacaoId: e.organizacaoId,
    correlationId: e.correlationId,
    occurredAt: e.createdAt,
    context,
  };
}

/** Cria uma regra simples: dispara para todo evento cuja `acao` bate no predicado. */
function simpleRule(
  rule: AlertRuleName,
  severity: AlertSeverity,
  summary: string,
  matches: (acao: string) => boolean,
  contextOf: (e: RawAuditEventForAlerting) => Record<string, unknown> = () => ({}),
) {
  return (events: readonly RawAuditEventForAlerting[]): AlertEvent[] =>
    events.filter((e) => matches(e.acao)).map((e) => toAlert(e, rule, severity, summary, contextOf(e)));
}

/** Tentativa cross-tenant: qualquer `security.cross_tenant_attempt` já é crítico por si só. */
export const evaluateCrossTenantAttempt = simpleRule(
  'crossTenantAttempt',
  'critical',
  'Tentativa de acesso/gravação cross-tenant detectada',
  (acao) => acao === 'security.cross_tenant_attempt',
  (e) => ({ actorId: e.actorId }),
);

/** Assinatura de webhook inválida: possível forjamento de payload externo. */
export const evaluateInvalidWebhookSignature = simpleRule(
  'invalidWebhookSignature',
  'critical',
  'Webhook recebido com assinatura inválida',
  (acao) => acao === 'webhook.signature_invalid',
  (e) => ({ provider: e.metadata.provider }),
);

/** Job/evento de outbox movido para dead-letter: esgotou tentativas sem sucesso. */
export const evaluateDeadLetter = simpleRule(
  'deadLetter',
  'critical',
  'Job/evento movido para dead-letter após esgotar tentativas',
  (acao) => acao === 'job.dead_letter',
);

/** Checagem de readiness/migration falhou — deploy potencialmente inseguro. */
export const evaluateMigrationReadiness = simpleRule(
  'migrationReadiness',
  'critical',
  'Checagem de readiness/migration falhou',
  (acao) => acao === 'org.migration_readiness_failed',
);

const OWNER_BILLING_EVENTS = new Set([
  'billing.owner_changed',
  'billing.plan_changed',
  'billing.payment_method_changed',
]);

/** Mudança de owner/billing: sempre notável, mesmo quando legítima. */
export function evaluateOwnerOrBillingChange(events: readonly RawAuditEventForAlerting[]): AlertEvent[] {
  return events
    .filter((e) => OWNER_BILLING_EVENTS.has(e.acao))
    .map((e) =>
      toAlert(
        e,
        'ownerOrBillingChange',
        e.acao === 'billing.owner_changed' ? 'critical' : 'warning',
        `Alteração privilegiada de billing: ${e.acao}`,
        { acao: e.acao, actorId: e.actorId },
      ),
    );
}

const ALL_RULES: Array<(events: readonly RawAuditEventForAlerting[]) => AlertEvent[]> = [
  evaluateAuthFailureBurst,
  evaluateCrossTenantAttempt,
  evaluateInvalidWebhookSignature,
  evaluateDeadLetter,
  evaluateMigrationReadiness,
  evaluateOwnerOrBillingChange,
];

/** Avalia todas as regras mínimas contra um lote de eventos e retorna os alertas disparados. */
export function evaluateAllRules(events: readonly RawAuditEventForAlerting[]): AlertEvent[] {
  return ALL_RULES.flatMap((rule) => rule(events));
}

/** Avalia todas as regras e envia cada alerta disparado ao sink informado. */
export async function dispatchAlerts(
  sink: AlertSink,
  events: readonly RawAuditEventForAlerting[],
): Promise<AlertEvent[]> {
  const alerts = evaluateAllRules(events);
  for (const alert of alerts) {
    await sink.send(alert);
  }
  return alerts;
}
