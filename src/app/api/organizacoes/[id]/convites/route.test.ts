/**
 * Regressão de fronteira do Ticket 20.
 *
 * Estes testes atravessam a autorização de verdade — `resolveAuthenticatedIdentity`,
 * `verifyOrganizationScope` e a tabela de capacidades — em vez de substituí-la por
 * um retorno pronto. Foi essa substituição que deixou a rota verde enquanto ela
 * negava, com 401, o dono da própria organização: o teste fabricava a sessão que
 * o provedor de identidade nunca emite.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ORG_ID = '20000000-0000-4000-8000-000000000001';
const OWNER_ID = '30000000-0000-4000-8000-000000000001';
const MEMBER_ID = '30000000-0000-4000-8000-000000000002';

const getUserMock = vi.fn();
const maybeSingleMock = vi.fn();
const listOrgInvitesMock = vi.fn();
const createOrgInviteMock = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    auth: { getUser: getUserMock },
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }),
      }),
    }),
  },
}));
vi.mock('@/lib/supabaseActorClient', () => ({
  createActorScopedSupabaseClient: () => ({ _tag: 'ActorScopedClientCreated', client: {} }),
}));
vi.mock('@/lib/invitationService', async () => {
  const real = await vi.importActual<typeof import('@/lib/invitationService')>('@/lib/invitationService');
  return { ...real, listOrgInvites: listOrgInvitesMock, createOrgInvite: createOrgInviteMock };
});

/** O `app_metadata` que o Supabase realmente emite: nenhuma pista de papel. */
function sessionOf(userId: string) {
  getUserMock.mockResolvedValue({
    data: { user: { id: userId, app_metadata: { provider: 'email', providers: ['email'] } } },
    error: null,
  });
}

function membershipOf(papel: 'owner' | 'admin' | 'member' | null) {
  maybeSingleMock.mockResolvedValue({ data: papel === null ? null : { papel }, error: null });
}

function request(method: 'GET' | 'POST', authorized = true): Request {
  return new Request(`https://orbita.test/api/organizacoes/${ORG_ID}/convites`, {
    method,
    headers: {
      ...(authorized ? { Authorization: 'Bearer token-de-sessao' } : {}),
      'Content-Type': 'application/json',
    },
    body: method === 'POST'
      ? JSON.stringify({ email: 'convidado@e2e.orbita.test', papel: 'member' })
      : undefined,
  });
}

const params = () => ({ params: Promise.resolve({ id: ORG_ID }) });

describe('GET /api/organizacoes/[id]/convites', () => {
  beforeEach(() => vi.clearAllMocks());

  it('devolve 401 sem sessão', async () => {
    const { GET } = await import('./route');
    const response = await GET(request('GET', false), params());
    expect(response.status).toBe(401);
    expect(listOrgInvitesMock).not.toHaveBeenCalled();
  });

  it('devolve 503 quando o provedor de identidade está indisponível', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'down', status: 503 } });
    const { GET } = await import('./route');
    const response = await GET(request('GET'), params());
    expect(response.status).toBe(503);
  });

  it('nega com 403 quem não tem vínculo com a organização, sem ler os convites', async () => {
    sessionOf(MEMBER_ID);
    membershipOf(null);
    const { GET } = await import('./route');
    const response = await GET(request('GET'), params());
    expect(response.status).toBe(403);
    expect(listOrgInvitesMock).not.toHaveBeenCalled();
  });

  it('nega com 403 o membro sem capacidade de gestão', async () => {
    sessionOf(MEMBER_ID);
    membershipOf('member');
    const { GET } = await import('./route');
    const response = await GET(request('GET'), params());
    expect(response.status).toBe(403);
    expect(listOrgInvitesMock).not.toHaveBeenCalled();
  });

  it('lista os convites para o dono', async () => {
    sessionOf(OWNER_ID);
    membershipOf('owner');
    listOrgInvitesMock.mockResolvedValue([]);
    const { GET } = await import('./route');
    const response = await GET(request('GET'), params());
    expect(response.status).toBe(200);
    expect(listOrgInvitesMock).toHaveBeenCalledWith(expect.anything(), ORG_ID);
  });
});

describe('POST /api/organizacoes/[id]/convites', () => {
  beforeEach(() => vi.clearAllMocks());

  it('devolve 401 sem sessão', async () => {
    const { POST } = await import('./route');
    const response = await POST(request('POST', false), params());
    expect(response.status).toBe(401);
  });

  it('devolve 403 — e não 401 — ao membro autenticado sem capacidade de gestão', async () => {
    sessionOf(MEMBER_ID);
    membershipOf('member');
    const { POST } = await import('./route');
    const response = await POST(request('POST'), params());
    expect(response.status).toBe(403);
    expect(createOrgInviteMock).not.toHaveBeenCalled();
  });

  it('cria o convite para o dono da organização', async () => {
    sessionOf(OWNER_ID);
    membershipOf('owner');
    createOrgInviteMock.mockResolvedValue({ token: 'a'.repeat(64) });
    const { POST } = await import('./route');
    const response = await POST(request('POST'), params());
    expect(response.status).toBe(201);
    expect(createOrgInviteMock).toHaveBeenCalled();
  });

  it('devolve 503 quando o depósito de vínculos está indisponível', async () => {
    sessionOf(OWNER_ID);
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const { POST } = await import('./route');
    const response = await POST(request('POST'), params());
    expect(response.status).toBe(503);
  });
});
