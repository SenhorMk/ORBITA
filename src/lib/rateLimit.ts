/**
 * Application-owned rate limiting port and pure decision logic.
 *
 * The store is a durable, server-side dependency (Postgres today, see
 * `rateLimitStore.ts`). Callers never see raw counters; they see a tagged
 * result that fails closed when the store cannot be reached.
 */

/** One rate-limited action recognised by the durable store. */
export type RateLimitAction = 'register' | 'bling_authorize' | 'bling_callback' | 'empresa_cnpj' | 'chatwoot_webhook' | 'sac_rascunho';

/** Outcome recorded by the durable store for one consume attempt. */
export type RateLimitStoreResult =
  | { readonly _tag: 'RateLimitRecorded'; readonly allowed: boolean; readonly count: number; readonly resetAt: number }
  | { readonly _tag: 'RateLimitStoreUnavailable'; readonly cause: string };

/** Durable capability required to enforce rate limits across requests. */
export interface RateLimitStorePort {
  readonly consume: (
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ) => Promise<RateLimitStoreResult>;
}

/** Policy applied to one rate-limited action. */
export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

/** Tagged decision returned to HTTP callers. */
export type RateLimitDecision =
  | { readonly _tag: 'RateLimitAllowed'; readonly remaining: number; readonly resetAt: number }
  | { readonly _tag: 'RateLimitBlocked'; readonly retryAfterMs: number; readonly resetAt: number }
  | { readonly _tag: 'RateLimitStoreUnavailable'; readonly cause: string };

/** A denial variant of `RateLimitDecision`, excluding the allowed path. */
export type RateLimitDenial = Exclude<RateLimitDecision, { readonly _tag: 'RateLimitAllowed' }>;

/** Conservative default policies; rollout starts strict and observable. */
export const DEFAULT_RATE_LIMIT_POLICIES: Readonly<Record<RateLimitAction, RateLimitPolicy>> = {
  register: { limit: 5, windowMs: 15 * 60 * 1_000 },
  bling_authorize: { limit: 10, windowMs: 5 * 60 * 1_000 },
  bling_callback: { limit: 20, windowMs: 5 * 60 * 1_000 },
  // Consulta de CNPJ no cadastro de contato: uma por empresa, com debounce no navegador.
  empresa_cnpj: { limit: 20, windowMs: 60 * 1_000 },
  // Entregas assinadas do webhook do Chatwoot, por conexão (MSG-005).
  chatwoot_webhook: { limit: 300, windowMs: 60 * 1_000 },
  sac_rascunho: { limit: 10, windowMs: 60 * 1_000 },
};

/** Check and record one rate-limited attempt for `action:identifier`. */
export async function checkRateLimit(
  store: RateLimitStorePort,
  action: RateLimitAction,
  identifier: string,
  policy: RateLimitPolicy,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const key = `${action}:${identifier}`;
  const result = await store.consume(key, policy.limit, policy.windowMs, now);

  if (result._tag === 'RateLimitStoreUnavailable') {
    return result;
  }

  if (!result.allowed) {
    return {
      _tag: 'RateLimitBlocked',
      retryAfterMs: Math.max(0, result.resetAt - now),
      resetAt: result.resetAt,
    };
  }

  return {
    _tag: 'RateLimitAllowed',
    remaining: Math.max(0, policy.limit - result.count),
    resetAt: result.resetAt,
  };
}

/** Map a rate limit denial to a safe HTTP status. Fail closed, never open. */
export function rateLimitDenialStatus(denial: RateLimitDenial): 429 | 503 {
  return denial._tag === 'RateLimitStoreUnavailable' ? 503 : 429;
}

/** Normalize the client IP from `x-forwarded-for`; falls back to a fixed bucket. */
export function normalizeIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (!forwardedFor) return 'unknown';

  const firstHop = forwardedFor.split(',')[0]?.trim();
  return firstHop && firstHop.length > 0 ? firstHop : 'unknown';
}
