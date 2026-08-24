import { beforeAll, describe, expect, it } from 'vitest';

describe('Bling OAuth Callback Handler', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  });

  it('rejects callback with missing state and transaction cookie', async () => {
    const { GET: callbackHandler } = await import('./route');
    const request = new Request('https://orbita.test/api/bling/callback?code=test-code');

    const response = await callbackHandler(request);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Transação OAuth ausente ou inválida');
    expect(response.headers.get('set-cookie')).toContain('orbita_oauth_transaction=;');
  });

  it('rejects callback with state mismatch', async () => {
    const { createOAuthTransaction } = await import('../../../../lib/oauth-transaction');
    const { GET: callbackHandler } = await import('./route');

    const transaction = createOAuthTransaction('user-tenant-1');
    if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('Transaction creation failed');

    const request = new Request('https://orbita.test/api/bling/callback?code=test-code&state=wrong-state', {
      headers: {
        cookie: `orbita_oauth_transaction=${transaction.cookieValue}`,
      },
    });

    const response = await callbackHandler(request);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Transação OAuth expirada ou inválida');
  });

  it('rejects callback when Bling returns error param', async () => {
    const { createOAuthTransaction } = await import('../../../../lib/oauth-transaction');
    const { GET: callbackHandler } = await import('./route');

    const transaction = createOAuthTransaction('user-tenant-1');
    if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('Transaction creation failed');

    const request = new Request(`https://orbita.test/api/bling/callback?error=access_denied&state=${transaction.state}`, {
      headers: {
        cookie: `orbita_oauth_transaction=${transaction.cookieValue}`,
      },
    });

    const response = await callbackHandler(request);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('O Bling recusou a autorização');
  });

  it('rejects callback when code is missing despite valid state', async () => {
    const { createOAuthTransaction } = await import('../../../../lib/oauth-transaction');
    const { GET: callbackHandler } = await import('./route');

    const transaction = createOAuthTransaction('user-tenant-1');
    if (transaction._tag !== 'OAuthTransactionCreated') throw new Error('Transaction creation failed');

    const request = new Request(`https://orbita.test/api/bling/callback?state=${transaction.state}`, {
      headers: {
        cookie: `orbita_oauth_transaction=${transaction.cookieValue}`,
      },
    });

    const response = await callbackHandler(request);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Código de autorização não retornado pelo Bling');
  });
});
