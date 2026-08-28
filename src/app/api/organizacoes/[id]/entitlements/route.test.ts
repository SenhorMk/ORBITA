import { describe, expect, it, vi, beforeEach } from 'vitest';

const verifySessionAndRoleMock = vi.fn();
const verifyOrganizationScopeMock = vi.fn();
const getOrganizationEntitlementsMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  verifySessionAndRole: (...args: unknown[]) => verifySessionAndRoleMock(...args),
}));
vi.mock('@/lib/verifiedOrganizationScope', () => ({
  verifyOrganizationScope: (...args: unknown[]) => verifyOrganizationScopeMock(...args),
}));
vi.mock('@/lib/supabaseServer', () => ({ supabaseServer: {} }));
vi.mock('@/services/entitlementsService', () => ({
  getOrganizationEntitlements: (...args: unknown[]) => getOrganizationEntitlementsMock(...args),
}));

const ORG_ID = '20000000-0000-4000-8000-000000000001';
const ACTOR_ID = '30000000-0000-4000-8000-000000000001';

function request(): Request {
  return new Request(`https://orbita.test/api/organizacoes/${ORG_ID}/entitlements`, { method: 'GET' });
}
function params() {
  return { params: Promise.resolve({ id: ORG_ID }) };
}

describe('GET /api/organizacoes/[id]/entitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without a verified session', async () => {
    verifySessionAndRoleMock.mockResolvedValue(null);
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(401);
    expect(getOrganizationEntitlementsMock).not.toHaveBeenCalled();
  });

  it('denies entitlements for an organization the actor does not belong to', async () => {
    verifySessionAndRoleMock.mockResolvedValue({ actorId: ACTOR_ID });
    verifyOrganizationScopeMock.mockResolvedValue({ _tag: 'OrganizationScopeDenied' });
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(403);
    expect(getOrganizationEntitlementsMock).not.toHaveBeenCalled();
  });

  it('returns the real plan/limits only after the scope is verified', async () => {
    verifySessionAndRoleMock.mockResolvedValue({ actorId: ACTOR_ID });
    verifyOrganizationScopeMock.mockResolvedValue({
      _tag: 'OrganizationScopeVerified',
      scope: { organizationId: ORG_ID, actorId: ACTOR_ID, role: 'owner' },
    });
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

  it('returns 500 when the entitlements lookup fails', async () => {
    verifySessionAndRoleMock.mockResolvedValue({ actorId: ACTOR_ID });
    verifyOrganizationScopeMock.mockResolvedValue({
      _tag: 'OrganizationScopeVerified',
      scope: { organizationId: ORG_ID, actorId: ACTOR_ID, role: 'owner' },
    });
    getOrganizationEntitlementsMock.mockRejectedValue(new Error('rpc down'));
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(500);
  });
});
