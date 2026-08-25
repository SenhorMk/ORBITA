import { randomBytes, timingSafeEqual } from 'node:crypto';

import { checkEncryptionConfiguration, decrypt, encrypt } from './crypto';
import type { VerifiedOrganizationScope } from './verifiedOrganizationScope';

const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1_000;

/** Protected data stored for a pending Bling OAuth authorization. */
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
      readonly reason: 'invalid-encryption-configuration';
    };

/** Result of validating a pending Bling OAuth transaction. */
export type OAuthTransactionReadResult =
  | {
      readonly _tag: 'ValidOAuthTransaction';
      readonly userId: string;
      readonly organizacaoId?: string;
    }
  | {
      readonly _tag: 'InvalidOAuthTransaction';
      readonly reason: 'expired' | 'malformed' | 'state-mismatch';
    };

type OAuthTransactionPayload = {
  readonly createdAt: number;
  readonly state: string;
  readonly userId: string;
  readonly organizacaoId?: string;
};

function isPayload(value: unknown): value is OAuthTransactionPayload {
  if (
    !value
    || typeof value !== 'object'
    || !('createdAt' in value)
    || !('state' in value)
    || !('userId' in value)
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const hasValidOrg = obj.organizacaoId === undefined || typeof obj.organizacaoId === 'string';
  return (
    typeof obj.createdAt === 'number'
    && typeof obj.state === 'string'
    && typeof obj.userId === 'string'
    && obj.state.length > 0
    && obj.userId.length > 0
    && hasValidOrg
  );
}

function statesMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    receivedBuffer.length === expectedBuffer.length
    && timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

/** Create an encrypted transaction that binds OAuth state to its initiating user and organization. */
export function createOAuthTransaction(
  userId: string,
  organizacaoIdOrCreatedAt?: string | number,
  createdAtInput?: number,
): OAuthTransactionCreationResult {
  const encryptionConfiguration = checkEncryptionConfiguration();
  if (encryptionConfiguration._tag === 'InvalidEncryptionConfiguration') {
    return {
      _tag: 'OAuthTransactionCreationFailed',
      reason: 'invalid-encryption-configuration',
    };
  }

  const organizacaoId = typeof organizacaoIdOrCreatedAt === 'string' ? organizacaoIdOrCreatedAt : undefined;
  const createdAt = typeof organizacaoIdOrCreatedAt === 'number'
    ? organizacaoIdOrCreatedAt
    : (createdAtInput ?? Date.now());

  const state = randomBytes(32).toString('base64url');
  const payload: OAuthTransactionPayload = {
    createdAt,
    state,
    userId,
    ...(organizacaoId ? { organizacaoId } : {}),
  };
  const cookieValue = encrypt(JSON.stringify(payload));
  if (!cookieValue) {
    return {
      _tag: 'OAuthTransactionCreationFailed',
      reason: 'invalid-encryption-configuration',
    };
  }

  return { _tag: 'OAuthTransactionCreated', state, cookieValue };
}

/** Create an OAuth transaction from a nominally verified organization scope. */
export function createScopedOAuthTransaction(
  scope: VerifiedOrganizationScope,
  createdAt = Date.now(),
): OAuthTransactionCreationResult {
  return createOAuthTransaction(scope.actorId, scope.organizationId, createdAt);
}

/** Validate and recover the initiating user and organization from an encrypted OAuth transaction. */
export function readOAuthTransaction(
  cookieValue: string,
  receivedState: string,
  currentTime = Date.now(),
): OAuthTransactionReadResult {
  if (!cookieValue.includes(':')) {
    return { _tag: 'InvalidOAuthTransaction', reason: 'malformed' };
  }

  const plaintext = decrypt(cookieValue);
  if (!plaintext) {
    return { _tag: 'InvalidOAuthTransaction', reason: 'malformed' };
  }

  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (!isPayload(parsed)) {
      return { _tag: 'InvalidOAuthTransaction', reason: 'malformed' };
    }
    if (currentTime < parsed.createdAt || currentTime - parsed.createdAt > OAUTH_TRANSACTION_TTL_MS) {
      return { _tag: 'InvalidOAuthTransaction', reason: 'expired' };
    }
    if (!statesMatch(receivedState, parsed.state)) {
      return { _tag: 'InvalidOAuthTransaction', reason: 'state-mismatch' };
    }

    return {
      _tag: 'ValidOAuthTransaction',
      userId: parsed.userId,
      ...(parsed.organizacaoId ? { organizacaoId: parsed.organizacaoId } : {}),
    };
  } catch {
    return { _tag: 'InvalidOAuthTransaction', reason: 'malformed' };
  }
}
