import { describe, expect, it } from 'vitest';

import { createBlingAuthorizeHandler, type BlingAuthorizeDependencies } from './route';
import type { OrganizationContextResult } from '../../../../lib/organizationAuthorization';
import type { OAuthTransactionStorePort } from '../../../../lib/oauthTransactionStore';
import type { RateLimitStorePort } from '../../../../lib/rateLimit';
import { OAUTH_TRANSACTION_TTL_SECONDS } from '../../../../lib/oauth-transaction';

const RESOLVED_CONTEXT: OrganizationContextResult = {
  _tag: 'OrganizationContextResolved',
  // SAFETY: test fixture matching the OrganizationContext shape; the private construction brand is omitted.
  context: {
    actorId: '30000000-0000-4000-8000-000000000001',
    user: { id: '30000000-0000-4000-8000-000000000001', app_metadata: {} },
    organizationId: '20000000-0000-4000-8000-000000000001',
    organization: {
      id: '20000000-0000-4000-8000-000000000001',
      nome: 'Org',
      slug: 'org',
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
    },
    role: 'owner',
    capabilities: new Set(['organization:access', 'organization:manage']),
    selectionVersion: 0,
  } as never,
};

function alwaysAllowRateLimit(): RateLimitStorePort {
  return { async consume() { return { _tag: 'RateLimitRecorded', allowed: true, count: 1, resetAt: Date.now() + 60_000 }; } };
}

function alwaysBlockRateLimit(): RateLimitStorePort {
  return { async consume() { return { _tag: 'RateLimitRecorded', allowed: false, count: 999, resetAt: Date.now() + 60_000 }; } };
}

function neverConsumedStore(): OAuthTransactionStorePort {
  return {
    async create() { return { _tag: 'OAuthTransactionStored', id: '11111111-1111-4111-8111-111111111111' }; },
    async consume() { return { _tag: 'OAuthTransactionConsumeDenied' }; },
  };
}

function baseDeps(overrides: Partial<BlingAuthorizeDependencies> = {}): BlingAuthorizeDependencies {
  return {
    resolveOrganizationContext: async () => RESOLVED_CONTEXT,
    findBlingClientId: async () => 'client-id-123',
    oauthTransactionStore: neverConsumedStore(),
    rateLimitStore: alwaysAllowRateLimit(),
    ...overrides,
  };
}

describe('GET /api/bling/authorize', () => {
  it('rejects with 429 when the rate limit is exceeded, before touching organization context', async () => {
    let contextCalls = 0;
    const handler = createBlingAuthorizeHandler(baseDeps({
      rateLimitStore: alwaysBlockRateLimit(),
      resolveOrganizationContext: async () => { contextCalls += 1; return RESOLVED_CONTEXT; },
    }));

    const response = await handler(new Request('https://orbita.test/api/bling/authorize'));

    expect(response.status).toBe(429);
    expect(contextCalls).toBe(0);
  });

  it('rejects with 503 when the rate limit store is unavailable, never allowing unlimited traffic', async () => {
    const handler = createBlingAuthorizeHandler(baseDeps({
      rateLimitStore: { async consume() { return { _tag: 'RateLimitStoreUnavailable', cause: 'down' }; } },
    }));

    const response = await handler(new Request('https://orbita.test/api/bling/authorize'));
    expect(response.status).toBe(503);
  });

  it('rejects when the organization context is not resolved', async () => {
    const handler = createBlingAuthorizeHandler(baseDeps({
      resolveOrganizationContext: async () => ({ _tag: 'SessionMissing' }),
    }));

    const response = await handler(new Request('https://orbita.test/api/bling/authorize'));
    expect(response.status).toBe(401);
  });

  it('issues an authorize URL and sets an opaque, HttpOnly, SameSite=Lax cookie scoped to the callback path', async () => {
    const handler = createBlingAuthorizeHandler(baseDeps());

    const response = await handler(new Request('https://orbita.test/api/bling/authorize'));
    expect(response.status).toBe(200);

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('orbita_oauth_transaction=11111111-1111-4111-8111-111111111111');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/api/bling/callback');

    const json = await response.json();
    expect(json.authorizeUrl).toContain('client_id=client-id-123');
    expect(json.authorizeUrl).toContain('state=');
  });

  it('nega com 403 quem não pode gerir integrações, igual a POST /api/bling/connect', async () => {
    let transacoesCriadas = 0;
    const handler = createBlingAuthorizeHandler(baseDeps({
      resolveOrganizationContext: async () => ({
        ...RESOLVED_CONTEXT,
        // SAFETY: mesma fixture, com as capacidades de um `member`.
        context: { ...RESOLVED_CONTEXT.context, capabilities: new Set(['organization:access']) } as never,
      }),
      oauthTransactionStore: {
        async create() { transacoesCriadas += 1; return { _tag: 'OAuthTransactionStored', id: '11111111-1111-4111-8111-111111111111' }; },
        async consume() { return { _tag: 'OAuthTransactionConsumeDenied' }; },
      },
    }));

    const response = await handler(new Request('https://orbita.test/api/bling/authorize'));

    expect(response.status).toBe(403);
    // A recusa acontece antes de qualquer transação existir: um `member` não
    // pode nem iniciar o OAuth com o Client ID do dono.
    expect(transacoesCriadas).toBe(0);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('permite owner e admin, que são quem gere a organização', async () => {
    for (const papel of ['owner', 'admin'] as const) {
      const handler = createBlingAuthorizeHandler(baseDeps({
        resolveOrganizationContext: async () => ({
          ...RESOLVED_CONTEXT,
          // SAFETY: mesma fixture, variando apenas o papel gestor.
          context: { ...RESOLVED_CONTEXT.context, role: papel } as never,
        }),
      }));
      const response = await handler(new Request('https://orbita.test/api/bling/authorize'));
      expect(response.status, papel).toBe(200);
    }
  });

  it('dá ao cookie o mesmo prazo da transação no servidor, e não um menor', async () => {
    const handler = createBlingAuthorizeHandler(baseDeps());
    const response = await handler(new Request('https://orbita.test/api/bling/authorize'));

    // Um cookie mais curto que a transação produz "o cookie não chegou" para
    // uma transação que ainda vale — o pior diagnóstico possível.
    expect(response.headers.get('set-cookie') ?? '').toContain(`Max-Age=${OAUTH_TRANSACTION_TTL_SECONDS}`);
    expect(OAUTH_TRANSACTION_TTL_SECONDS).toBe(30 * 60);
  });
});
