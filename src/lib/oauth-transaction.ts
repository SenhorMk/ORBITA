import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { OAuthProvider, OAuthTransactionStorePort } from './oauthTransactionStore';
import type { VerifiedOrganizationScope } from './verifiedOrganizationScope';

const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1_000;
const cookieValueSchema = z.uuid();

/** Protected data returned to the caller after creating a pending OAuth transaction. */
export type OAuthTransaction = {
  readonly _tag: 'OAuthTransactionCreated';
  readonly state: string;
  readonly cookieValue: string;
};

/** Typed outcome of creating a protected OAuth transaction. */
export type OAuthTransactionCreationResult =
  | OAuthTransaction
  | {
      readonly _tag: 'OAuthTransactionCreationFailed';
      readonly reason: 'store-unavailable';
      readonly cause: string;
    };

/** Result of validating and atomically consuming a pending Bling OAuth transaction. */
export type OAuthTransactionConsumeResult =
  | {
      readonly _tag: 'ValidOAuthTransaction';
      readonly userId: string;
      readonly organizacaoId?: string;
    }
  | {
      readonly _tag: 'InvalidOAuthTransaction';
      readonly reason: 'malformed' | 'expired' | 'state-mismatch' | 'store-unavailable';
    };

function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/**
 * Create a server-side, single-use OAuth transaction. The returned `cookieValue`
 * is an opaque reference (the store row id) — it carries no secret, actor,
 * organization or provider data by itself. The `state` travels through the
 * provider redirect and must match the stored hash on the way back.
 */
export async function createOAuthTransaction(
  actorId: string,
  organizacaoId: string | undefined,
  provider: OAuthProvider,
  store: OAuthTransactionStorePort,
  now: number = Date.now(),
): Promise<OAuthTransactionCreationResult> {
  const state = randomBytes(32).toString('base64url');
  const result = await store.create({
    actorId,
    organizacaoId,
    provider,
    stateHash: hashState(state),
    expiresAt: now + OAUTH_TRANSACTION_TTL_MS,
  });

  if (result._tag === 'OAuthTransactionStoreUnavailable') {
    return { _tag: 'OAuthTransactionCreationFailed', reason: 'store-unavailable', cause: result.cause };
  }

  return { _tag: 'OAuthTransactionCreated', state, cookieValue: result.id };
}

/** Create an OAuth transaction from a nominally verified organization scope. */
export function createScopedOAuthTransaction(
  scope: VerifiedOrganizationScope,
  store: OAuthTransactionStorePort,
  now: number = Date.now(),
): Promise<OAuthTransactionCreationResult> {
  return createOAuthTransaction(scope.actorId, scope.organizationId, 'bling', store, now);
}

/**
 * Validate the received state in constant time against its stored hash and
 * atomically consume the transaction so a replayed callback (same cookie,
 * same state) can never succeed twice or trigger a second token exchange.
 */
export async function consumeOAuthTransaction(
  cookieValue: string,
  receivedState: string,
  store: OAuthTransactionStorePort,
  now: number = Date.now(),
): Promise<OAuthTransactionConsumeResult> {
  const idResult = cookieValueSchema.safeParse(cookieValue);
  if (!idResult.success || receivedState.length === 0) {
    return { _tag: 'InvalidOAuthTransaction', reason: 'malformed' };
  }

  const result = await store.consume(idResult.data, hashState(receivedState), now);

  if (result._tag === 'OAuthTransactionStoreUnavailable') {
    return { _tag: 'InvalidOAuthTransaction', reason: 'store-unavailable' };
  }
  if (result._tag === 'OAuthTransactionConsumeDenied') {
    // The store does not distinguish expired/mismatched/already-consumed rows in
    // its return value (all deny consumption identically), which is itself the
    // replay- and enumeration-resistant behavior this boundary requires.
    return { _tag: 'InvalidOAuthTransaction', reason: 'state-mismatch' };
  }

  return {
    _tag: 'ValidOAuthTransaction',
    userId: result.actorId,
    ...(result.organizacaoId ? { organizacaoId: result.organizacaoId } : {}),
  };
}
