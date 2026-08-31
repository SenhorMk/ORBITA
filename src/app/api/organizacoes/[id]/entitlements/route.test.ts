/**
 * Ticket 20 — este teste passou a atravessar a autorização real, em vez de
 * fabricar a sessão que o provedor de identidade nunca emite.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getUserMock = vi.fn();
const maybeSingleMock = vi.fn();
const getOrganizationEntitlementsMock = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    auth: { getUser: getUserMock },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
    }),
  },
}));
vi.mock('@/services/entitlementsService', () => ({
  getOrganizationEntitlements: (...args: unknown[]) => getOrganizationEntitlementsMock(...args),
}));

const ORG_ID = '20000000-0000-4000-8000-000000000001';
const ACTOR_ID = '30000000-0000-4000-8000-000000000001';

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
  return new Request(`https://orbita.test/api/organizacoes/${ORG_ID}/entitlements`, {
    method: 'GET',
    headers: authorized ? { Authorization: 'Bearer token-de-sessao' } : {},
  });
}
function params() {
  return { params: Promise.resolve({ id: ORG_ID }) };
}

describe('GET /api/organizacoes/[id]/entitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devolve 401 sem sessão', async () => {
    const { GET } = await import('./route');

    const response = await GET(request(false), params());

    expect(response.status).toBe(401);
    expect(getOrganizationEntitlementsMock).not.toHaveBeenCalled();
  });

  it('nega com 403 quem não tem vínculo com a organização', async () => {
    sessionOf(ACTOR_ID);
    membershipOf(null);
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(403);
    expect(getOrganizationEntitlementsMock).not.toHaveBeenCalled();
  });

  it('devolve o plano real a quem tem vínculo, mesmo sem papel de gestão', async () => {
    sessionOf(ACTOR_ID);
    membershipOf('member');
    const entitlements = {
      organizacao_id: ORG_ID,
      plano_id: '40000000-0000-4000-8000-000000000001',
      plano_nome: 'Pro',
      plano_slug: 'pro',
      status: 'active',
      limite_membros: 10,
      limite_conexoes_bling: 2,
      limite_conexoes_chatwoot: 2,
      recursos: {},
      periodo_inicio: '2026-08-01T00:00:00Z',
      periodo_fim: null,
    };
    getOrganizationEntitlementsMock.mockResolvedValue(entitlements);
    const { GET } = await import('./route');

    const response = await GET(request(), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getOrganizationEntitlementsMock).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    expect(body.entitlements).toEqual(entitlements);
  });

  it('devolve 500 quando a consulta de plano falha', async () => {
    sessionOf(ACTOR_ID);
    membershipOf('owner');
    getOrganizationEntitlementsMock.mockRejectedValue(new Error('rpc down'));
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(500);
  });

  it('devolve 503 quando o depósito de vínculos está indisponível', async () => {
    sessionOf(ACTOR_ID);
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(503);
    expect(getOrganizationEntitlementsMock).not.toHaveBeenCalled();
  });
});
