/**
 * Regressão de fronteira do Ticket 20 — revogação de membro.
 *
 * Atravessa a autorização real. Antes, a rota chamava o atalho de sessão, que
 * responde `null` tanto para "sem sessão" quanto para "sem vínculo", e negava
 * com 401 até o dono da organização.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ORG_ID = '20000000-0000-4000-8000-000000000001';
const OWNER_ID = '30000000-0000-4000-8000-000000000001';
const MEMBER_ID = '30000000-0000-4000-8000-000000000002';

const getUserMock = vi.fn();
const maybeSingleMock = vi.fn();
const revokeOrgMemberMock = vi.fn();

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
vi.mock('@/lib/invitationService', () => ({ revokeOrgMember: revokeOrgMemberMock }));

function sessionOf(userId: string) {
  getUserMock.mockResolvedValue({
    data: { user: { id: userId, app_metadata: { provider: 'email', providers: ['email'] } } },
    error: null,
  });
}

function membershipOf(papel: 'owner' | 'admin' | 'member' | null) {
  maybeSingleMock.mockResolvedValue({ data: papel === null ? null : { papel }, error: null });
}

function request(authorized = true): Request {
  return new Request(`https://orbita.test/api/organizacoes/${ORG_ID}/membros/${MEMBER_ID}`, {
    method: 'DELETE',
    headers: authorized ? { Authorization: 'Bearer token-de-sessao' } : {},
  });
}

const params = () => ({ params: Promise.resolve({ id: ORG_ID, userId: MEMBER_ID }) });

describe('DELETE /api/organizacoes/[id]/membros/[userId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('devolve 401 sem sessão', async () => {
    const { DELETE } = await import('./route');
    const response = await DELETE(request(false), params());
    expect(response.status).toBe(401);
    expect(revokeOrgMemberMock).not.toHaveBeenCalled();
  });

  it('devolve 403 — e não 401 — ao membro autenticado sem capacidade de gestão', async () => {
    sessionOf(MEMBER_ID);
    membershipOf('member');
    const { DELETE } = await import('./route');
    const response = await DELETE(request(), params());
    expect(response.status).toBe(403);
    expect(revokeOrgMemberMock).not.toHaveBeenCalled();
  });

  it('devolve 403 a quem não tem vínculo com a organização', async () => {
    sessionOf(OWNER_ID);
    membershipOf(null);
    const { DELETE } = await import('./route');
    const response = await DELETE(request(), params());
    expect(response.status).toBe(403);
    expect(revokeOrgMemberMock).not.toHaveBeenCalled();
  });

  it('revoga o membro quando quem chama é o dono', async () => {
    sessionOf(OWNER_ID);
    membershipOf('owner');
    revokeOrgMemberMock.mockResolvedValue(true);
    const { DELETE } = await import('./route');
    const response = await DELETE(request(), params());
    expect(response.status).toBe(200);
    expect(revokeOrgMemberMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, MEMBER_ID);
  });

  it('devolve 503 quando o depósito de vínculos está indisponível', async () => {
    sessionOf(OWNER_ID);
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const { DELETE } = await import('./route');
    const response = await DELETE(request(), params());
    expect(response.status).toBe(503);
  });
});
