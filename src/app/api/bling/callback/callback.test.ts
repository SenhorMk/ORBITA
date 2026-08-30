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
    // Sem state e sem cookie: a mensagem nomeia as duas metades.
    expect(html).toContain('não devolveu o parâmetro state');
    expect(html).toContain('cookie da sessão de conexão também não chegou');
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


  /** Executa o callback com uma transacao valida e a query informada. */
  async function callbackWithQuery(query: string): Promise<Response> {
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);
    const handler = createBlingCallbackHandler(baseDeps({ oauthTransactionStore: store }));
    return handler(new Request(`https://orbita.test/api/bling/callback?${query}&state=${transaction.state}`, {
      headers: { cookie: `orbita_oauth_transaction=${transaction.cookieValue}` },
    }));
  }

  it('mostra o motivo que o Bling devolveu, em vez de apenas "recusou a autorizacao"', async () => {
    const html = await (await callbackWithQuery('error=invalid_client')).text();

    expect(html).toContain('O Bling recusou a autorização');
    expect(html).toContain('invalid_client');
    // A dica precisa dizer o que fazer, não só nomear o código.
    expect(html).toContain('Client ID');
  });

  it('traduz access_denied para algo acionável', async () => {
    const html = await (await callbackWithQuery('error=access_denied')).text();

    expect(html).toContain('access_denied');
    expect(html).toContain('negada');
  });

  it('não ecoa conteúdo arbitrário da query string para dentro da página', async () => {
    const html = await (await callbackWithQuery(
      'error=%3Cscript%3Ealert(1)%3C%2Fscript%3E&error_description=%3Cimg%20onerror%3D1%3E',
    )).text();

    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('unknown_error');
  });

  it('oferece um link de volta ao ORBITA e nunca fecha a aba sem opener', async () => {
    const html = await (await callbackWithQuery('error=server_error')).text();

    expect(html).toContain('Voltar para o ORBITA');
    // O fechamento só existe dentro do guard `if (window.opener)`.
    expect(html).not.toContain('onclick="window.close()"');
  });


  it('explica que forbidden e sobre escopos do usuario Bling, nao sobre as credenciais', async () => {
    const html = await (await callbackWithQuery('error=forbidden')).text();

    expect(html).toContain('forbidden');
    expect(html).toContain('escopos');
    // Precisa apontar a acao concreta, senao repete o beco sem saida anterior.
    expect(html).toContain('proprietário da conta');
  });


  it('distingue "o Bling nao devolveu state" de "o cookie nao chegou"', async () => {
    // Juntar as duas metades numa mensagem so apagava o diagnostico: sao
    // causas completamente diferentes, com acoes diferentes.
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);
    const handler = createBlingCallbackHandler(baseDeps({ oauthTransactionStore: store }));

    // Cookie presente, state ausente -> problema na URL de retorno cadastrada.
    const semState = await handler(new Request('https://orbita.test/api/bling/callback?code=abc', {
      headers: { cookie: `orbita_oauth_transaction=${transaction.cookieValue}` },
    }));
    const htmlSemState = await semState.text();
    expect(htmlSemState).toContain('não devolveu o parâmetro state');
    expect(htmlSemState).toContain('/api/bling/callback');

    // State presente, cookie ausente -> problema de sessao/aba/tempo.
    const semCookie = await handler(
      new Request(`https://orbita.test/api/bling/callback?code=abc&state=${transaction.state}`),
    );
    const htmlSemCookie = await semCookie.text();
    expect(htmlSemCookie).toContain('cookie da sessão de conexão não chegou');
    expect(htmlSemCookie).toContain('mesma aba');
  });

  it('o state e hexadecimal, formato que a documentacao do Bling exemplifica', async () => {
    const store = inMemoryOAuthTransactionStore();
    const transaction = await createValidTransaction(store);

    // Sem `-` nem `_`: um caractere que o provedor possa nao preservar no
    // redirect e uma variavel a mais entre nos e o token.
    expect(transaction.state).toMatch(/^[0-9a-f]{32}$/u);
  });

});
