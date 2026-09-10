import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ticket 26 — passo 4 (auditoria dos demais callers).
 *
 * `criar_organizacao_atomica` was not the only `security definer` RPC that
 * derives its actor from `auth.uid()` while being invoked through the
 * `service_role` client. Auditing `database/*.sql` against `src/` found the
 * same mismatch in `aceitar_convite_organizacao` and
 * `revogar_membro_organizacao`.
 *
 * Both are covered here at the HTTP boundary with a faked Supabase API — no
 * client-shaped mock — so the caller's identity is observable and a regression
 * to `supabaseServer` reproduces the production failure instead of passing.
 */

const SUPABASE_URL = 'https://orbita-staging.supabase.co';
const ANON_KEY = 'anon-key-staging-fake-123456789';
const SERVICE_ROLE_KEY = 'service-role-staging-fake-123456789';
const USER_ACCESS_TOKEN = 'user-jwt-access-token-fake-123456789';
const USER_ID = '96000000-0000-4000-8000-000000000002';
const ORG_ID = '96000000-0000-4000-8000-000000000001';
const TARGET_MEMBER_ID = '96000000-0000-4000-8000-000000000003';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

/** One recorded call against the faked Supabase HTTP boundary. */
interface RecordedSupabaseCall {
  readonly path: string;
  readonly authorization: string | null;
}

/** The fake's model of `auth.uid()`: only a known access token carries a subject. */
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
 * PostgREST resolves `auth.uid()` from the bearer, so a bearer with no user
 * subject makes every `auth.uid()`-bound RPC raise `42501`, like the deployed
 * database did.
 */
async function supabaseHttpFake(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const authorization = headers.get('Authorization');
  const bearer = /^Bearer\s+(.+)$/iu.exec(authorization?.trim() ?? '')?.[1] ?? null;
  const subject = bearer === null ? null : subjectByAccessToken.get(bearer) ?? null;
  const path = new URL(requestUrl(input)).pathname;

  recordedCalls.push({ path, authorization });

  if (path === '/auth/v1/user') {
    return subject === null
      ? jsonResponse({ message: 'invalid claim: missing sub claim', code: 401 }, 401)
      : jsonResponse(
          {
            id: subject,
            aud: 'authenticated',
            role: 'authenticated',
            // O provedor real não devolve papel aqui; a autoridade sobre
            // papel é a tabela de vínculos consultada abaixo (Ticket 20).
            app_metadata: { provider: 'email', providers: ['email'] },
            user_metadata: {},
          },
          200,
        );
  }

  // Vínculo persistido: é daqui que sai o papel que autoriza a revogação
  // (Ticket 20). O fake responde como o projeto real responderia para o dono.
  // Leitura privilegiada, feita com a service_role key: ela não carrega
  // sujeito, e não precisa — o par (organização, ator) vai no filtro.
  if (path === '/rest/v1/membros_organizacao') {
    return bearer === SERVICE_ROLE_KEY
      ? jsonResponse({ papel: 'owner' }, 200)
      : jsonResponse({ message: 'leitura de vínculo exige a chave de serviço' }, 401);
  }

  if (path.startsWith('/rest/v1/rpc/')) {
    return subject === null
      ? jsonResponse({ code: '42501', details: null, hint: null, message: 'Usuario nao autenticado' }, 400)
      : jsonResponse(path.endsWith('revogar_membro_organizacao') ? true : ORG_ID, 200);
  }

  return jsonResponse({ message: `rota Supabase inesperada no teste: ${path}` }, 500);
}

function rpcCall(functionName: string): RecordedSupabaseCall {
  const call = recordedCalls.find((recorded) => recorded.path === `/rest/v1/rpc/${functionName}`);
  if (!call) {
    throw new Error(`A rota não executou ${functionName} contra o Supabase.`);
  }
  return call;
}

describe('RPCs ligadas a auth.uid() executadas com a identidade do usuário', () => {
  beforeEach(() => {
    recordedCalls = [];
    vi.stubGlobal('fetch', supabaseHttpFake);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST /api/convites/aceitar executa aceitar_convite_organizacao com o JWT do usuário', async () => {
    const { createAcceptInviteHandler } = await import('./convites/aceitar/route');
    let activeOrganization: string | null = null;
    const handler = createAcceptInviteHandler({
      // A seleção da organização ingressada passa pelo CAS (Ticket 06); aqui só
      // interessa que a RPC do aceite viajou com o JWT do usuário.
      selecionarSeNaoHouverSelecao: async () => ({ _tag: 'OrganizationSwitchApplied', version: 1 }),
      gravarCookieDeOrganizacaoAtiva: async (organizacaoId) => {
        activeOrganization = organizacaoId;
      },
    });

    const response = await handler(
      new Request('https://orbita.test/api/convites/aceitar', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${USER_ACCESS_TOKEN}` },
        body: JSON.stringify({ token: 'a'.repeat(64) }),
      }),
    );

    expect(rpcCall('aceitar_convite_organizacao').authorization).toBe(`Bearer ${USER_ACCESS_TOKEN}`);
    expect(rpcCall('aceitar_convite_organizacao').authorization).not.toContain(SERVICE_ROLE_KEY);
    expect(response.status).toBe(200);
    expect(activeOrganization).toBe(ORG_ID);
  });

  it('DELETE /api/organizacoes/[id]/membros/[userId] executa revogar_membro_organizacao com o JWT do usuário', async () => {
    const { DELETE } = await import('./organizacoes/[id]/membros/[userId]/route');

    const response = await DELETE(
      new Request(`https://orbita.test/api/organizacoes/${ORG_ID}/membros/${TARGET_MEMBER_ID}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${USER_ACCESS_TOKEN}` },
      }),
      { params: Promise.resolve({ id: ORG_ID, userId: TARGET_MEMBER_ID }) },
    );

    expect(rpcCall('revogar_membro_organizacao').authorization).toBe(`Bearer ${USER_ACCESS_TOKEN}`);
    expect(rpcCall('revogar_membro_organizacao').authorization).not.toContain(SERVICE_ROLE_KEY);
    expect(response.status).toBe(200);
  });
});
