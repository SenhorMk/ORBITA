/**
 * subscriptionLifecycle.ts
 * Ticket 13: Máquina de estados pura de assinatura/ciclo de vida da organização.
 *
 * Independente de Next.js, Supabase e Stripe. Estado é modelado como tagged union
 * (nunca booleans soltos como `isSuspended`/`isCancelled`). Entrada externa é sempre
 * um evento já parseado com timestamp e versão do provedor/sistema; estado antigo
 * nunca regride o estado novo (protege contra webhooks fora de ordem/replays).
 */

export type SubscriptionLifecycleKind =
  | 'trial'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'suspended'
  | 'pending_deletion';

export type SubscriptionLifecycleState =
  | { readonly kind: 'trial'; readonly since: string }
  | { readonly kind: 'active'; readonly since: string }
  | { readonly kind: 'past_due'; readonly since: string }
  | { readonly kind: 'cancelled'; readonly since: string }
  | { readonly kind: 'suspended'; readonly since: string; readonly reason: string }
  | { readonly kind: 'pending_deletion'; readonly since: string; readonly scheduledFor: string };

export type LifecycleEventType =
  | 'trial_started'
  | 'activated'
  | 'payment_failed'
  | 'cancelled'
  | 'suspended'
  | 'reactivated'
  | 'deletion_scheduled'
  | 'deletion_cancelled';

/** Evento externo já parseado (Zod) na fronteira do webhook/RPC. Nunca autoridade crua do cliente. */
export interface LifecycleEvent {
  readonly type: LifecycleEventType;
  /** Timestamp de origem do provedor/sistema (ISO 8601), não o horário de recebimento local. */
  readonly occurredAt: string;
  /** Versão/sequência monotônica do provedor/sistema para esse recurso. */
  readonly version: number;
  readonly reason?: string;
  readonly scheduledFor?: string;
}

export interface VersionedLifecycleState {
  readonly state: SubscriptionLifecycleState;
  readonly appliedAt: string;
  readonly version: number;
}

export type TransitionOutcome =
  | { readonly outcome: 'applied'; readonly next: VersionedLifecycleState }
  | {
      readonly outcome: 'rejected_stale';
      readonly current: VersionedLifecycleState;
      readonly reason: string;
    }
  | {
      readonly outcome: 'rejected_invalid_transition';
      readonly current: VersionedLifecycleState;
      readonly reason: string;
    }
  | { readonly outcome: 'noop_duplicate'; readonly current: VersionedLifecycleState };

/** Matriz explícita de transições válidas por estado atual. Fonte única da verdade. */
const ALLOWED_TRANSITIONS: Readonly<Record<SubscriptionLifecycleKind, ReadonlySet<LifecycleEventType>>> = {
  trial: new Set(['activated', 'cancelled', 'suspended', 'payment_failed']),
  active: new Set(['payment_failed', 'cancelled', 'suspended', 'deletion_scheduled']),
  past_due: new Set(['activated', 'cancelled', 'suspended']),
  cancelled: new Set(['activated', 'deletion_scheduled']),
  suspended: new Set(['reactivated', 'deletion_scheduled', 'cancelled']),
  pending_deletion: new Set(['deletion_cancelled', 'suspended']),
};

function nextKindFor(eventType: LifecycleEventType): SubscriptionLifecycleKind | null {
  switch (eventType) {
    case 'trial_started':
      return 'trial';
    case 'activated':
      return 'active';
    case 'payment_failed':
      return 'past_due';
    case 'cancelled':
      return 'cancelled';
    case 'suspended':
      return 'suspended';
    case 'reactivated':
      return 'active';
    case 'deletion_scheduled':
      return 'pending_deletion';
    case 'deletion_cancelled':
      return 'active';
    default:
      return null;
  }
}

function buildState(kind: SubscriptionLifecycleKind, event: LifecycleEvent): SubscriptionLifecycleState {
  switch (kind) {
    case 'trial':
      return { kind: 'trial', since: event.occurredAt };
    case 'active':
      return { kind: 'active', since: event.occurredAt };
    case 'past_due':
      return { kind: 'past_due', since: event.occurredAt };
    case 'cancelled':
      return { kind: 'cancelled', since: event.occurredAt };
    case 'suspended':
      return { kind: 'suspended', since: event.occurredAt, reason: event.reason ?? 'nao especificado' };
    case 'pending_deletion':
      return {
        kind: 'pending_deletion',
        since: event.occurredAt,
        scheduledFor: event.scheduledFor ?? event.occurredAt,
      };
  }
}

/**
 * Aplica um evento externo já parseado ao estado versionado atual.
 *
 * Invariante central do ticket: um evento com versão/timestamp mais antigo que o
 * estado já aplicado nunca regride o estado — é rejeitado como `rejected_stale`,
 * mesmo que a transição em si fosse válida. Reentrega do mesmo evento (mesma versão)
 * é idempotente (`noop_duplicate`). Transições fora da matriz são `rejected_invalid_transition`.
 */
export function applyLifecycleEvent(
  current: VersionedLifecycleState,
  event: LifecycleEvent,
): TransitionOutcome {
  if (event.version < current.version) {
    return {
      outcome: 'rejected_stale',
      current,
      reason: `Evento versao ${event.version} e anterior ao estado atual (versao ${current.version}); ignorado para nao regredir estado.`,
    };
  }

  if (event.version === current.version) {
    return { outcome: 'noop_duplicate', current };
  }

  if (event.occurredAt < current.appliedAt) {
    return {
      outcome: 'rejected_stale',
      current,
      reason: `Timestamp do evento (${event.occurredAt}) e anterior ao ultimo estado aplicado (${current.appliedAt}); ignorado para nao regredir estado.`,
    };
  }

  const nextKind = nextKindFor(event.type);
  if (!nextKind) {
    return {
      outcome: 'rejected_invalid_transition',
      current,
      reason: `Tipo de evento desconhecido: ${event.type}`,
    };
  }

  const allowedFromCurrent = ALLOWED_TRANSITIONS[current.state.kind];
  if (!allowedFromCurrent.has(event.type)) {
    return {
      outcome: 'rejected_invalid_transition',
      current,
      reason: `Transicao "${current.state.kind}" -> "${event.type}" nao e permitida pela matriz de estados.`,
    };
  }

  return {
    outcome: 'applied',
    next: {
      state: buildState(nextKind, event),
      appliedAt: event.occurredAt,
      version: event.version,
    },
  };
}

export function initialLifecycleState(occurredAt: string): VersionedLifecycleState {
  return { state: { kind: 'trial', since: occurredAt }, appliedAt: occurredAt, version: 0 };
}
