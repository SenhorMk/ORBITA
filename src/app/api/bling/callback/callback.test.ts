import { describe, expect, it } from 'vitest';

import { createBlingCallbackHandler, type BlingCallbackDependencies, type ResolvedBlingCredentials } from './route';
import { createOAuthTransaction } from '../../../../lib/oauth-transaction';
import type { OAuthTransactionStorePort } from '../../../../lib/oauthTransactionStore';
import type { RateLimitStorePort } from '../../../../lib/rateLimit';

function inMemoryOAuthTransactionStore(): OAuthTransactionStorePort {
  const rows = new Map<
    string,
    { actorId: string; organizacaoId: string | undefined; stateHash: string; expiresAt: number; consumedAt: number | null }
  >();
  let nextId = 0;
  return {
    async create(input) {
      nextId += 1;
      const id = `33333333-3333-4333-8333-33333333333${nextId}`;
      rows.set(id, { actorId: input.actorId, organizacaoId: input.organizacaoId, stateHash: input.stateHash, expiresAt: input.expiresAt, consumedAt: null });
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

function alwaysAllowRateLimit(): RateLimitStorePort {
  return { async consume() { return { _tag: 'RateLimitRecorded', allowed: true, count: 1, resetAt: Date.now() + 60_000 }; } };
}

function alwaysBlockRateLimit(): RateLimitStorePort {
  return { async consume() { return { _tag: 'RateLimitRecorded', allowed: false, count: 999, resetAt: Date.now() + 60_000 }; } };
}

const CREDENTIALS: ResolvedBlingCredentials = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  organizationConnectionId: null,
  legacyRecordId: 'legacy-1',
};

function baseDeps(overrides: Partial<BlingCallbackDependencies> = {}): BlingCallbackDependencies {
  return {
    oauthTransactionStore: inMemoryOAuthTransactionStore(),
    rateLimitStore: alwaysAllowRateLimit(),
    exchangeAuthorizationCode: async () => ({
      _tag: 'BlingOAuthTokenExchanged',
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3600,
    } as never),
    resolveCredentials: async () => CREDENTIALS,
    persistTokens: async () => {},
    ...overrides,
  };
}

async function createValidTransaction(store: OAuthTransactionStorePort) {
  const transaction = await createOAuthTransaction('user-tenant-1', undefined, 'bling', store);
  if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('Transaction creation failed');
  return transaction;
}

describe('GET /api/bling/callback', () => {
  it('rejects with 429 when the IP rate limit is exceeded, before reading the transaction', async () => {
    const handler = createBlingCallbackHandler(baseDeps({ rateLimitStore: alwaysBlockRateLimit() }));
    const response = await handler(new Request('https://orbita.test/api/bling/callback?code=test-code&state=any'));

    expect(response.status).toBe(429);
  });

  it('rejects callback with missing state and transaction cookie', async () => {
    const handler = createBlingCallbackHandler(baseDeps());
    const request = new Request('https://orbita.test/api/bling/callback?code=test-code');

    const response = await handler(request);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Transação OAuth ausente ou inválida');
    expect(response.headers.get('set-cookie')).toContain('orbita_oauth_transaction=;');
  });

  it('rejects callback with a state that does not match the stored transaction', async () => {
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);
    const handler = createBlingCallbackHandler(baseDeps({ oauthTransactionStore: store }));

    const request = new Request('https://orbita.test/api/bling/callback?code=test-code&state=wrong-state', {
      headers: { cookie: `orbita_oauth_transaction=${transaction.cookieValue}` },
    });

    const response = await handler(request);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Transação OAuth expirada ou inválida');
  });

  it('rejects a replayed callback (same cookie/state used twice) with no second token exchange', async () => {
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);
    let exchangeCalls = 0;
    const handler = createBlingCallbackHandler(baseDeps({
      oauthTransactionStore: store,
      exchangeAuthorizationCode: async () => {
        exchangeCalls += 1;
        return { _tag: 'BlingOAuthTokenExchanged', access_token: 'a', refresh_token: 'r', expires_in: 3600 } as never;
      },
    }));

    const request = () => new Request(`https://orbita.test/api/bling/callback?code=test-code&state=${transaction.state}`, {
      headers: { cookie: `orbita_oauth_transaction=${transaction.cookieValue}` },
    });

    const first = await handler(request());
    const replay = await handler(request());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(400);
    const replayHtml = await replay.text();
    expect(replayHtml).toContain('Transação OAuth expirada ou inválida');
    expect(exchangeCalls).toBe(1);
  });

  it('rejects callback when Bling returns error param, after consuming the transaction', async () => {
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);
    const handler = createBlingCallbackHandler(baseDeps({ oauthTransactionStore: store }));

    const request = new Request(`https://orbita.test/api/bling/callback?error=access_denied&state=${transaction.state}`, {
      headers: { cookie: `orbita_oauth_transaction=${transaction.cookieValue}` },
    });

    const response = await handler(request);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('O Bling recusou a autorização');
  });

  it('rejects callback when code is missing despite valid state', async () => {
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);
    const handler = createBlingCallbackHandler(baseDeps({ oauthTransactionStore: store }));

    const request = new Request(`https://orbita.test/api/bling/callback?state=${transaction.state}`, {
      headers: { cookie: `orbita_oauth_transaction=${transaction.cookieValue}` },
    });

    const response = await handler(request);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Código de autorização não retornado pelo Bling');
  });

  it('rejects with 429 when the per-actor rate limit is exceeded after a valid transaction', async () => {
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);
    let calls = 0;
    const handler = createBlingCallbackHandler(baseDeps({
      oauthTransactionStore: store,
      rateLimitStore: {
        async consume() {
          calls += 1;
          // First call is the IP bucket (allow); second call is the actor bucket (block).
          return calls === 1
            ? { _tag: 'RateLimitRecorded', allowed: true, count: 1, resetAt: Date.now() + 60_000 }
            : { _tag: 'RateLimitRecorded', allowed: false, count: 999, resetAt: Date.now() + 60_000 };
        },
      },
    }));

    const request = new Request(`https://orbita.test/api/bling/callback?code=test-code&state=${transaction.state}`, {
      headers: { cookie: `orbita_oauth_transaction=${transaction.cookieValue}` },
    });

    const response = await handler(request);
    expect(response.status).toBe(429);
  });

  it('completes successfully on a valid, unconsumed transaction with matching state', async () => {
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);
    let persisted: unknown = null;
    const handler = createBlingCallbackHandler(baseDeps({
      oauthTransactionStore: store,
      persistTokens: async (input) => { persisted = input; },
    }));

    const request = new Request(`https://orbita.test/api/bling/callback?code=test-code&state=${transaction.state}`, {
      headers: { cookie: `orbita_oauth_transaction=${transaction.cookieValue}` },
    });

    const response = await handler(request);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Conexão Realizada');
    expect(persisted).toMatchObject({ userId: 'user-tenant-1', accessToken: 'access-token-value' });
  });
});
