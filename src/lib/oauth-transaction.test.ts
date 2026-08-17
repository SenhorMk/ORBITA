import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEncryptionKey = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
  vi.resetModules();
});

afterEach(() => {
  if (originalEncryptionKey === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  }
  vi.resetModules();
});

describe('Bling OAuth transaction', () => {
  it('binds a cryptographically random state to the initiating user', async () => {
    const { createOAuthTransaction, readOAuthTransaction } = await import(
      './oauth-transaction'
    );
    const createdAt = 1_700_000_000_000;
    const transaction = createOAuthTransaction('user-123', createdAt);
    if (transaction._tag !== 'OAuthTransactionCreated') {
      throw new Error('OAuth transaction was not created.');
    }

    expect(transaction.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(
      readOAuthTransaction(transaction.cookieValue, transaction.state, createdAt + 1_000),
    ).toEqual({ _tag: 'ValidOAuthTransaction', userId: 'user-123' });
  });

  it('rejects a state that does not match the protected transaction', async () => {
    const { createOAuthTransaction, readOAuthTransaction } = await import(
      './oauth-transaction'
    );
    const transaction = createOAuthTransaction('user-123', 1_700_000_000_000);
    if (transaction._tag !== 'OAuthTransactionCreated') {
      throw new Error('OAuth transaction was not created.');
    }

    expect(
      readOAuthTransaction(transaction.cookieValue, 'attacker-state', 1_700_000_001_000),
    ).toEqual({ _tag: 'InvalidOAuthTransaction', reason: 'state-mismatch' });
  });

  it('rejects an expired transaction', async () => {
    const { createOAuthTransaction, readOAuthTransaction } = await import(
      './oauth-transaction'
    );
    const createdAt = 1_700_000_000_000;
    const transaction = createOAuthTransaction('user-123', createdAt);
    if (transaction._tag !== 'OAuthTransactionCreated') {
      throw new Error('OAuth transaction was not created.');
    }

    expect(
      readOAuthTransaction(transaction.cookieValue, transaction.state, createdAt + 600_001),
    ).toEqual({ _tag: 'InvalidOAuthTransaction', reason: 'expired' });
  });

  it('returns a typed configuration failure when encryption is unavailable', async () => {
    delete process.env.ENCRYPTION_KEY;
    vi.resetModules();
    const { createOAuthTransaction } = await import('./oauth-transaction');

    expect(createOAuthTransaction('user-123')).toEqual({
      _tag: 'OAuthTransactionCreationFailed',
      reason: 'invalid-encryption-configuration',
    });
  });
});
