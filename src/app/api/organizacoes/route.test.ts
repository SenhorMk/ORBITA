import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for Ticket 26 — Defeito 1.
 *
 * The previous coverage (`src/e2e/saas-lifecycle.test.ts`) replaced the Supabase
 * client with `{ rpc: vi.fn() }` and asserted only `p_nome`/`p_slug`. That mock
 * hides the single fact that matters for `criar_organizacao_atomica`: the RPC is
 * `security definer` and derives its owner from `auth.uid()`, so it only works
 * when the request carries the *end user's* JWT. Calling it with the
 * `service_role` key leaves `auth.uid()` NULL and the function always aborts —
 * and the old assertion stayed green through that defect all the way to
 * production.
 *
 * This test therefore refuses to mock the Supabase client at all. It fakes the
 * Supabase HTTP boundary (the external system ORBITA does not own) and models
 * the one server rule that produced the outage: PostgREST resolves `auth.uid()`
 * from the `Authorization` bearer, and the `service_role` key carries no user
 * subject. The caller's identity is observable, so a regression to
 * `supabaseServer` reproduces the owner's exact production error instead of
 * passing silently.
 */

const SUPABASE_URL = 'https://orbita-staging.supabase.co';
const ANON_KEY = 'anon-key-staging-fake-123456789';
const SERVICE_ROLE_KEY = 'service-role-staging-fake-123456789';
const USER_ACCESS_TOKEN = 'user-jwt-access-token-fake-123456789';
const USER_ID = '95000000-0000-4000-8000-000000000002';
const CREATED_ORG_ID = '95000000-0000-4000-8000-000000000001';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

/** One recorded call against the faked Supabase HTTP boundary. */
interface RecordedSupabaseCall {
  readonly path: string;
  readonly authorization: string | null;
  readonly apiKey: string | null;
}

/**
 * Access tokens the faked GoTrue instance recognises, mapped to their subject.
 *
 * This is the fake's model of `auth.uid()`: a bearer present here resolves to a
 * user, anything else (the `service_role` key included) resolves to NULL.
 */
const subjectByAccessToken = new Map<string, string>([[USER_ACCESS_TOKEN, USER_ID]]);

let recordedCalls: RecordedSupabaseCall[] = [];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Stand-in for the Supabase project's HTTP API.
 *
 * `/auth/v1/user` behaves like GoTrue token introspection and
 * `/rest/v1/rpc/criar_organizacao_atomica` behaves like PostgREST executing the
 * `security definer` function: when the bearer carries no user subject,
 * `auth.uid()` is NULL and the function raises `42501`, exactly as the deployed
 * database did for the owner.
 */
async function supabaseHttpFake(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  const headers = new Headers(init?.headers);
  const authorization = headers.get('Authorization');
  const bearer = /^Bearer\s+(.+)$/iu.exec(authorization?.trim() ?? '')?.[1] ?? null;
  const subject = bearer === null ? null : subjectByAccessToken.get(bearer) ?? null;
  const path = new URL(url).pathname;

  recordedCalls.push({ path, authorization, apiKey: headers.get('apikey') });

  if (path === '/auth/v1/user') {
    return subject === null
      ? jsonResponse({ message: 'invalid claim: missing sub claim', code: 401 }, 401)
      : jsonResponse({ id: subject, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }, 200);
  }

  if (path === '/rest/v1/rpc/criar_organizacao_atomica') {
    return subject === null
      ? jsonResponse(
          {
            code: '42501',
            details: null,
            hint: null,
            message: 'Usuario nao autenticado para criar organizacao',
          },
          400,
        )
      : jsonResponse(CREATED_ORG_ID, 200);
  }

  return jsonResponse({ message: `rota Supabase inesperada no teste: ${path}` }, 500);
}

function createOrganizationRequest(): Request {
  return new Request('https://orbita.test/api/organizacoes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${USER_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ nome: 'Empresa Matriz', slug: 'empresa-matriz' }),
  });
}

function rpcCall(): RecordedSupabaseCall {
  const call = recordedCalls.find((recorded) => recorded.path === '/rest/v1/rpc/criar_organizacao_atomica');
  if (!call) {
    throw new Error('A rota não executou criar_organizacao_atomica contra o Supabase.');
  }
  return call;
}

describe('POST /api/organizacoes', () => {
  beforeEach(() => {
    recordedCalls = [];
    vi.stubGlobal('fetch', supabaseHttpFake);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('executa criar_organizacao_atomica com o JWT do usuário, e não com a service_role key', async () => {
    const { POST } = await import('./route');

    const response = await POST(createOrganizationRequest());
    const body: unknown = await response.json();

    expect(rpcCall().authorization).toBe(`Bearer ${USER_ACCESS_TOKEN}`);
    expect(response.status).toBe(201);
    expect(body).toEqual({
      organizacao: { id: CREATED_ORG_ID, nome: 'Empresa Matriz', slug: 'empresa-matriz' },
    });
  });

  it('nunca envia a service_role key como identidade do chamador da RPC', async () => {
    const { POST } = await import('./route');

    await POST(createOrganizationRequest());

    const call = rpcCall();
    expect(call.authorization).not.toContain(SERVICE_ROLE_KEY);
    expect(call.apiKey).not.toBe(SERVICE_ROLE_KEY);
  });

  it('recusa a criação sem sessão verificada, sem tocar na RPC', async () => {
    const { POST } = await import('./route');

    const response = await POST(
      new Request('https://orbita.test/api/organizacoes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nome: 'Empresa Matriz', slug: 'empresa-matriz' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(recordedCalls.some((call) => call.path.startsWith('/rest/v1/rpc/'))).toBe(false);
  });
});
