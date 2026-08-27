import { describe, expect, it } from 'vitest';

import {
  consumeOAuthTransaction,
  createOAuthTransaction,
} from './oauth-transaction';
import type { OAuthTransactionStorePort } from './oauthTransactionStore';

/**
 * Deterministic in-memory fake implementing the real store port — not a
 * module mock. It reproduces the same single-use, expiring, hash-checked
 * semantics as the production Postgres-backed adapter.
 */
function createFakeStore(): OAuthTransactionStorePort {
  const rows = new Map<
    string,
    { actorId: string; organizacaoId: string | undefined; stateHash: string; expiresAt: number; consumedAt: number | null }
  >();
  let nextId = 0;

  return {
    async create(input) {
      nextId += 1;
      const id = `11111111-1111-4111-8111-11111111111${nextId}`;
      rows.set(id, {
        actorId: input.actorId,
        organizacaoId: input.organizacaoId,
        stateHash: input.stateHash,
        expiresAt: input.expiresAt,
        consumedAt: null,
      });
      return { _tag: 'OAuthTransactionStored', id };
    },
    async consume(id, stateHash, now) {
      const row = rows.get(id);
      if (!row || row.consumedAt !== null || row.expiresAt <= now || row.stateHash !== stateHash) {
        return { _tag: 'OAuthTransactionConsumeDenied' };
      }
      row.consumedAt = now;
      return { _tag: 'OAuthTransactionConsumed', actorId: row.actorId, organizacaoId: row.organizacaoId };
    },
  };
}

const unavailableStore: OAuthTransactionStorePort = {
  async create() {
    return { _tag: 'OAuthTransactionStoreUnavailable', cause: 'connection-refused' };
  },
  async consume() {
    return { _tag: 'OAuthTransactionStoreUnavailable', cause: 'connection-refused' };
  },
};

describe('Bling OAuth transaction (server-side single-use store)', () => {
  it('binds a cryptographically random state to the initiating actor and organization', async () => {
    const store = createFakeStore();
    const createdAt = 1_700_000_000_000;
    const transaction = await createOAuthTransaction('user-123', 'org-456', 'bling', store, createdAt);
    if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('OAuth transaction was not created.');

    expect(transaction.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // The cookie value is an opaque reference (the store row id), never the raw state or payload.
    expect(transaction.cookieValue).not.toBe(transaction.state);

    const result = await consumeOAuthTransaction(transaction.cookieValue, transaction.state, store, createdAt + 1_000);
    expect(result).toEqual({ _tag: 'ValidOAuthTransaction', userId: 'user-123', organizacaoId: 'org-456' });
  });

  it('rejects a state that does not match the protected transaction', async () => {
    const store = createFakeStore();
    const transaction = await createOAuthTransaction('user-123', undefined, 'bling', store, 1_700_000_000_000);
    if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('OAuth transaction was not created.');

    const result = await consumeOAuthTransaction(transaction.cookieValue, 'attacker-state', store, 1_700_000_001_000);
    expect(result).toEqual({ _tag: 'InvalidOAuthTransaction', reason: 'state-mismatch' });
  });

  it('rejects an expired transaction', async () => {
    const store = createFakeStore();
    const createdAt = 1_700_000_000_000;
    const transaction = await createOAuthTransaction('user-123', undefined, 'bling', store, createdAt);
    if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('OAuth transaction was not created.');

    const result = await consumeOAuthTransaction(transaction.cookieValue, transaction.state, store, createdAt + 600_001);
    expect(result).toEqual({ _tag: 'InvalidOAuthTransaction', reason: 'state-mismatch' });
  });

  it('rejects a replayed (already-consumed) transaction and performs no second effect', async () => {
    const store = createFakeStore();
    const createdAt = 1_700_000_000_000;
    const transaction = await createOAuthTransaction('user-123', undefined, 'bling', store, createdAt);
    if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('OAuth transaction was not created.');

    const first = await consumeOAuthTransaction(transaction.cookieValue, transaction.state, store, createdAt + 1_000);
    const replay = await consumeOAuthTransaction(transaction.cookieValue, transaction.state, store, createdAt + 2_000);

    expect(first._tag).toBe('ValidOAuthTransaction');
    expect(replay).toEqual({ _tag: 'InvalidOAuthTransaction', reason: 'state-mismatch' });
  });

  it('rejects a malformed (non-UUID) cookie reference without touching the store', async () => {
    const store = createFakeStore();

    const result = await consumeOAuthTransaction('not-a-uuid', 'any-state', store, Date.now());
    expect(result).toEqual({ _tag: 'InvalidOAuthTransaction', reason: 'malformed' });
  });

  it('rejects an empty received state', async () => {
    const store = createFakeStore();
    const transaction = await createOAuthTransaction('user-123', undefined, 'bling', store, 1_700_000_000_000);
    if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('OAuth transaction was not created.');

    const result = await consumeOAuthTransaction(transaction.cookieValue, '', store, 1_700_000_000_000);
    expect(result).toEqual({ _tag: 'InvalidOAuthTransaction', reason: 'malformed' });
  });

  it('returns a typed store-unavailable failure on creation when the durable store cannot be reached', async () => {
    const result = await createOAuthTransaction('user-123', undefined, 'bling', unavailableStore);
    expect(result).toEqual({
      _tag: 'OAuthTransactionCreationFailed',
      reason: 'store-unavailable',
      cause: 'connection-refused',
    });
  });

  it('fails closed on consumption when the durable store cannot be reached', async () => {
    const result = await consumeOAuthTransaction(
      '22222222-2222-4222-8222-222222222222',
      'some-state',
      unavailableStore,
    );
    expect(result).toEqual({ _tag: 'InvalidOAuthTransaction', reason: 'store-unavailable' });
  });
});
