/**
 * titularRequestStateMachine.ts
 * Ticket 17: máquina de estados pura da jornada de direitos do titular
 * (LGPD). Independente de Next.js, Supabase e qualquer provider. Estado é
 * modelado como tagged union (nunca booleans soltos como `isVerified`); toda
 * transição passa pela matriz explícita `ALLOWED_TRANSITIONS`, nunca por
 * checagem ad-hoc. Ver `docs/adr/ticket-17-direitos-titular.md`.
 */

export type TitularRequestStateKind =
  | 'received'
  | 'identity_pending'
  | 'verified'
  | 'in_review'
  | 'approved'
  | 'partially_denied'
  | 'denied'
  | 'executing'
  | 'completed'
  | 'failed';

export type TitularRequestEventType =
  | 'identity_challenge_issued'
  | 'identity_verified'
  | 'identity_rejected'
  | 'identity_expired'
  | 'review_started'
  | 'approved'
  | 'partially_denied'
  | 'denied'
  | 'execution_started'
  | 'execution_completed'
  | 'execution_failed';

/** Estado versionado da solicitação. `since` é sempre o timestamp de origem
 * do evento que produziu o estado, nunca o horário de recebimento local. */
export type TitularRequestState =
  | { readonly kind: 'received'; readonly since: string }
  | { readonly kind: 'identity_pending'; readonly since: string; readonly challengeExpiresAt: string }
  | { readonly kind: 'verified'; readonly since: string; readonly verifiedBy: string }
  | { readonly kind: 'in_review'; readonly since: string; readonly reviewerId: string }
  | { readonly kind: 'approved'; readonly since: string; readonly reviewerId: string }
  | {
      readonly kind: 'partially_denied';
      readonly since: string;
      readonly reviewerId: string;
      readonly reasonCode: string;
    }
  | { readonly kind: 'denied'; readonly since: string; readonly reviewerId: string; readonly reasonCode: string }
  | { readonly kind: 'executing'; readonly since: string }
  | { readonly kind: 'completed'; readonly since: string }
  | { readonly kind: 'failed'; readonly since: string; readonly reasonCode: string };

/** Evento externo já parseado (Zod) na fronteira do serviço/rota. Nunca
 * autoridade crua do cliente: `actorId`/capability já vieram verificados. */
export interface TitularRequestEvent {
  readonly type: TitularRequestEventType;
  readonly occurredAt: string;
  /** Sequência monotônica por solicitação — protege contra replay fora de ordem. */
  readonly version: number;
  readonly actorId?: string;
  readonly challengeExpiresAt?: string;
  readonly reasonCode?: string;
}

export interface VersionedTitularRequestState {
  readonly state: TitularRequestState;
  readonly appliedAt: string;
  readonly version: number;
}

export type TitularRequestTransitionOutcome =
  | { readonly outcome: 'applied'; readonly next: VersionedTitularRequestState }
  | { readonly outcome: 'rejected_stale'; readonly current: VersionedTitularRequestState; readonly reason: string }
  | {
      readonly outcome: 'rejected_invalid_transition';
      readonly current: VersionedTitularRequestState;
      readonly reason: string;
    }
  | {
      readonly outcome: 'rejected_missing_reason';
      readonly current: VersionedTitularRequestState;
      readonly reason: string;
    }
  | { readonly outcome: 'noop_duplicate'; readonly current: VersionedTitularRequestState };

/** Matriz explícita de transições válidas por estado atual. Fonte única da
 * verdade — nenhuma transição fora daqui é aplicada, mesmo que "faça
 * sentido" ad-hoc no chamador. */
const ALLOWED_TRANSITIONS: Readonly<Record<TitularRequestStateKind, ReadonlySet<TitularRequestEventType>>> = {
  received: new Set(['identity_challenge_issued']),
  identity_pending: new Set(['identity_verified', 'identity_rejected', 'identity_expired']),
  verified: new Set(['review_started']),
  in_review: new Set(['approved', 'partially_denied', 'denied']),
  approved: new Set(['execution_started']),
  partially_denied: new Set(['execution_started']),
  denied: new Set([]),
  executing: new Set(['execution_completed', 'execution_failed']),
  completed: new Set([]),
  failed: new Set([]),
};

/** Eventos terminais (`identity_rejected`/`identity_expired`) não retornam a
 * `received`; encerram a jornada como `failed` com o motivo técnico —
 * evita reabrir uma solicitação sem uma nova jornada explícita. */
function nextKindFor(eventType: TitularRequestEventType): TitularRequestStateKind | null {
  switch (eventType) {
    case 'identity_challenge_issued':
      return 'identity_pending';
    case 'identity_verified':
      return 'verified';
    case 'identity_rejected':
    case 'identity_expired':
      return 'failed';
    case 'review_started':
      return 'in_review';
    case 'approved':
      return 'approved';
    case 'partially_denied':
      return 'partially_denied';
    case 'denied':
      return 'denied';
    case 'execution_started':
      return 'executing';
    case 'execution_completed':
      return 'completed';
    case 'execution_failed':
      return 'failed';
    default:
      return null;
  }
}

/** Eventos que exigem `reasonCode` não vazio — nunca uma negação/retenção/
 * falha silenciosa. */
const REASON_REQUIRED_EVENTS: ReadonlySet<TitularRequestEventType> = new Set([
  'identity_rejected',
  'identity_expired',
  'partially_denied',
  'denied',
  'execution_failed',
]);

/** Eventos que exigem `actorId` (o operador responsável pela decisão),
 * distinto do titular que fez a solicitação. */
const ACTOR_REQUIRED_EVENTS: ReadonlySet<TitularRequestEventType> = new Set([
  'review_started',
  'approved',
  'partially_denied',
  'denied',
]);

function buildState(
  kind: TitularRequestStateKind,
  event: TitularRequestEvent,
  current: TitularRequestState,
): TitularRequestState {
  switch (kind) {
    case 'received':
      return { kind: 'received', since: event.occurredAt };
    case 'identity_pending':
      return {
        kind: 'identity_pending',
        since: event.occurredAt,
        challengeExpiresAt: event.challengeExpiresAt ?? event.occurredAt,
      };
    case 'verified':
      // SAFETY: ACTOR_REQUIRED_EVENTS não inclui identity_verified; actorId aqui é
      // opcional no evento (pode ser o próprio titular autenticado) e sempre defensivamente coalescido.
      return { kind: 'verified', since: event.occurredAt, verifiedBy: event.actorId ?? 'titular' };
    case 'in_review':
      return { kind: 'in_review', since: event.occurredAt, reviewerId: event.actorId as string };
    case 'approved':
      return { kind: 'approved', since: event.occurredAt, reviewerId: event.actorId as string };
    case 'partially_denied':
      return {
        kind: 'partially_denied',
        since: event.occurredAt,
        reviewerId: event.actorId as string,
        reasonCode: event.reasonCode as string,
      };
    case 'denied':
      return {
        kind: 'denied',
        since: event.occurredAt,
        reviewerId: event.actorId as string,
        reasonCode: event.reasonCode as string,
      };
    case 'executing':
      return { kind: 'executing', since: event.occurredAt };
    case 'completed':
      return { kind: 'completed', since: event.occurredAt };
    case 'failed':
      return {
        kind: 'failed',
        since: event.occurredAt,
        reasonCode: event.reasonCode ?? `estado_anterior:${current.kind}`,
      };
  }
}

/**
 * Aplica um evento externo já parseado ao estado versionado atual.
 *
 * Invariantes:
 * - versão/timestamp mais antigo que o estado atual nunca regride o estado
 *   (`rejected_stale`), mesmo que a transição em si fosse válida;
 * - reentrega do mesmo evento (mesma versão) é idempotente
 *   (`noop_duplicate`) — cobre pedido repetido/retry de rede;
 * - transição fora da matriz é `rejected_invalid_transition`, nunca aplicada;
 * - evento que exige motivo/ator sem esses campos é `rejected_missing_reason`,
 *   nunca uma negação/retenção silenciosa.
 */
export function applyTitularRequestEvent(
  current: VersionedTitularRequestState,
  event: TitularRequestEvent,
): TitularRequestTransitionOutcome {
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

  if (REASON_REQUIRED_EVENTS.has(event.type) && !event.reasonCode?.trim()) {
    return {
      outcome: 'rejected_missing_reason',
      current,
      reason: `Evento "${event.type}" exige reasonCode nao vazio (proibido negar/reter/falhar sem fundamento registrado).`,
    };
  }

  if (ACTOR_REQUIRED_EVENTS.has(event.type) && !event.actorId?.trim()) {
    return {
      outcome: 'rejected_missing_reason',
      current,
      reason: `Evento "${event.type}" exige actorId do operador responsavel pela decisao.`,
    };
  }

  return {
    outcome: 'applied',
    next: {
      state: buildState(nextKind, event, current.state),
      appliedAt: event.occurredAt,
      version: event.version,
    },
  };
}

export function initialTitularRequestState(occurredAt: string): VersionedTitularRequestState {
  return { state: { kind: 'received', since: occurredAt }, appliedAt: occurredAt, version: 0 };
}

/** Verdade única sobre se um dado estado permite export/acesso a dados
 * pessoais do titular — nunca antes de `verified`. */
export function stateAllowsDataDisclosure(kind: TitularRequestStateKind): boolean {
  return kind === 'verified' || kind === 'in_review' || kind === 'approved' || kind === 'executing' || kind === 'completed';
}
