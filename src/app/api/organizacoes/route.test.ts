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
const ORG_DO_USUARIO = {
  id: '95000000-0000-4000-8000-000000000003',
  nome: 'Organização do Usuário',
  slug: 'org-do-usuario',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

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

  // Leituras do PostgREST que o `GET` faz. Elas não decidem identidade — quem
  // decide é `/auth/v1/user`, acima —, então aqui só devolvem forma válida.
  if (path === '/rest/v1/membros_organizacao') {
    return jsonResponse(
      [
        {
          papel: 'owner',
          organizacao_id: ORG_DO_USUARIO.id,
          organizacoes: ORG_DO_USUARIO,
        },
      ],
      200,
    );
  }
  if (path === '/rest/v1/contextos_organizacao_ativos') {
    return jsonResponse(null, 200);
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

/**
 * Ticket 24 — o mecanismo em que a spec de organização tropeçou.
 *
 * A autenticação deste aplicativo é por **bearer**: `readBearerToken` lê o token
 * exclusivamente do header `Authorization`. `page.request`, do Playwright,
 * compartilha os **cookies** da página — e cookie aqui não vale nada.
 *
 * Duas chamadas da spec iam cruas, sem header, e recebiam 401. A spec quebrava
 * antes da revogação que ela existe para testar, e a asserção seguinte lia o
 * corpo de um 401 e concluía que a organização tinha sumido da lista.
 *
 * Os dois casos abaixo fixam a assimetria que causou isso, na rota de verdade.
 */
describe('GET /api/organizacoes — a credencial vem do header, não do cookie', () => {
  beforeEach(() => {
    recordedCalls = [];
    vi.stubGlobal('fetch', supabaseHttpFake);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('devolve 401 sem o header `Authorization`, e não consulta o PostgREST', async () => {
    const { GET } = await import('./route');

    const response = await GET(new Request('https://orbita.test/api/organizacoes'));

    expect(response.status).toBe(401);
    expect(recordedCalls.some((call) => call.path.startsWith('/rest/v1/'))).toBe(false);
  });

  // O ponto exato: **um cookie de sessão não autentica nada.** Era a premissa
  // da spec, e do comentário que a acompanhava.
  it('devolve 401 com cookie de sessão e sem header', async () => {
    const { GET } = await import('./route');

    const response = await GET(
      new Request('https://orbita.test/api/organizacoes', {
        headers: { cookie: `sb-access-token=${USER_ACCESS_TOKEN}; sb-refresh-token=qualquer` },
      }),
    );

    expect(response.status).toBe(401);
    expect(recordedCalls.some((call) => call.path.startsWith('/rest/v1/'))).toBe(false);
  });

  it('devolve 200 com o header, para a mesma sessão', async () => {
    const { GET } = await import('./route');

    const response = await GET(
      new Request('https://orbita.test/api/organizacoes', {
        headers: { Authorization: `Bearer ${USER_ACCESS_TOKEN}` },
      }),
    );
    const corpo = (await response.json()) as { organizacoes: { id: string }[] };

    expect(response.status).toBe(200);
    expect(corpo.organizacoes.map((o) => o.id)).toEqual([ORG_DO_USUARIO.id]);
  });
});
