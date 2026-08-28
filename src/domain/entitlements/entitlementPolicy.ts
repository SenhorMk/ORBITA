/**
 * entitlementPolicy.ts
 * Ticket 13: Política única de autorização por estado de ciclo de vida + limites de plano.
 *
 * Módulo de domínio puro. Nenhuma rota deve reimplementar `if plan === ...` ou
 * `if status === ...`; toda decisão de bloqueio passa por `evaluateEntitlementPolicy`.
 */

import type { SubscriptionLifecycleState } from './subscriptionLifecycle';

export type EntitlementOperationCategory = 'resource_mutation' | 'read' | 'export';

/** Operação de negócio a autorizar. `name` é usado apenas para mensagens/telemetria. */
export interface EntitlementOperation {
  readonly category: EntitlementOperationCategory;
  readonly name: string;
  /** Recurso limitado consumido pela operação (membros, conexoes_bling, conexoes_chatwoot), se houver. */
  readonly limitedResource?: 'membros' | 'conexoes_bling' | 'conexoes_chatwoot';
  /** Feature booleana exigida pelo plano (ex: export_relatorios), se houver. */
  readonly requiredFeature?: string;
}

export type EntitlementDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: 'LIFECYCLE_BLOCKED' | 'FEATURE_NOT_INCLUDED' | 'LIMIT_EXCEEDED';
      readonly reason: string;
    };

/**
 * Estados em que mutações de consumo de recurso são bloqueadas. Leitura e exportação
 * (LGPD: direito de acesso/portabilidade) permanecem sempre permitidas em qualquer estado —
 * nunca bloqueadas aqui, mesmo em suspensão ou encerramento agendado.
 */
const MUTATION_BLOCKED_STATES: ReadonlySet<SubscriptionLifecycleState['kind']> = new Set([
  'cancelled',
  'suspended',
  'pending_deletion',
]);

export interface EntitlementLimitsSnapshot {
  readonly limite_membros: number;
  readonly limite_conexoes_bling: number;
  readonly limite_conexoes_chatwoot: number;
  readonly recursos: Readonly<Record<string, boolean>>;
}

export interface ResourceUsageSnapshot {
  readonly membros: number;
  readonly conexoes_bling: number;
  readonly conexoes_chatwoot: number;
}

/**
 * Avalia a política de entitlement para uma operação, combinando o estado de ciclo de
 * vida (bloqueio de mutação), o limite numérico do plano (contagem atual vs limite) e
 * features booleanas. Leitura/exportação nunca são bloqueadas por ciclo de vida.
 *
 * A contagem aqui é uma checagem *advisória* de fast-fail; a reserva atomicamente segura
 * contra concorrência acontece no RPC do banco (ver migration 49) — mesma regra, dupla
 * camada de defesa, não uma regra duplicada divergente.
 */
export function evaluateEntitlementPolicy(
  state: SubscriptionLifecycleState,
  operation: EntitlementOperation,
  limits: EntitlementLimitsSnapshot,
  usage: ResourceUsageSnapshot,
): EntitlementDecision {
  if (operation.category === 'read' || operation.category === 'export') {
    return { allowed: true };
  }

  if (MUTATION_BLOCKED_STATES.has(state.kind)) {
    return {
      allowed: false,
      code: 'LIFECYCLE_BLOCKED',
      reason: `Operacao "${operation.name}" bloqueada: organizacao/assinatura em estado "${state.kind}".`,
    };
  }

  if (operation.requiredFeature && !limits.recursos[operation.requiredFeature]) {
    return {
      allowed: false,
      code: 'FEATURE_NOT_INCLUDED',
      reason: `O recurso "${operation.requiredFeature}" nao esta disponivel no plano atual.`,
    };
  }

  if (operation.limitedResource) {
    const limit =
      operation.limitedResource === 'membros'
        ? limits.limite_membros
        : operation.limitedResource === 'conexoes_bling'
          ? limits.limite_conexoes_bling
          : limits.limite_conexoes_chatwoot;
    const current = usage[operation.limitedResource];
    if (current >= limit) {
      return {
        allowed: false,
        code: 'LIMIT_EXCEEDED',
        reason: `Limite de "${operation.limitedResource}" atingido (${current}/${limit}).`,
      };
    }
  }

  return { allowed: true };
}
