import { describe, expect, it, vi, beforeEach } from 'vitest';

const verifySessionAndRoleMock = vi.fn();
const verifyOrganizationScopeMock = vi.fn();
const orderMock = vi.fn();
const eqMock = vi.fn(() => ({ order: orderMock }));
const selectMock = vi.fn(() => ({ eq: eqMock }));
const fromMock = vi.fn(() => ({ select: selectMock }));

vi.mock('@/lib/auth', () => ({
  verifySessionAndRole: verifySessionAndRoleMock,
}));
vi.mock('@/lib/verifiedOrganizationScope', () => ({
  verifyOrganizationScope: verifyOrganizationScopeMock,
}));
vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: { from: fromMock },
}));

const ORG_ID = '20000000-0000-4000-8000-000000000001';
const ACTOR_ID = '30000000-0000-4000-8000-000000000001';

function request(): Request {
  return new Request(`https://orbita.test/api/organizacoes/${ORG_ID}/membros`, { method: 'GET' });
}

function params() {
  return { params: Promise.resolve({ id: ORG_ID }) };
}

describe('GET /api/organizacoes/[id]/membros', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when there is no verified session', async () => {
    verifySessionAndRoleMock.mockResolvedValue(null);
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(401);
  });

  it('denies listing members for an organization the actor does not belong to', async () => {
    verifySessionAndRoleMock.mockResolvedValue({ actorId: ACTOR_ID });
    verifyOrganizationScopeMock.mockResolvedValue({ _tag: 'OrganizationScopeDenied' });
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('lists members only after the organization scope is verified server-side', async () => {
    verifySessionAndRoleMock.mockResolvedValue({ actorId: ACTOR_ID });
    verifyOrganizationScopeMock.mockResolvedValue({
      _tag: 'OrganizationScopeVerified',
      scope: { organizationId: ORG_ID, actorId: ACTOR_ID, role: 'owner' },
    });
    orderMock.mockResolvedValue({
      data: [
        { user_id: ACTOR_ID, papel: 'owner', created_at: '2026-08-01T00:00:00Z' },
        { user_id: 'invalid-not-a-uuid', papel: 'member', created_at: '2026-08-02T00:00:00Z' },
      ],
      error: null,
    });
    const { GET } = await import('./route');

    const response = await GET(request(), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fromMock).toHaveBeenCalledWith('membros_organizacao');
    expect(eqMock).toHaveBeenCalledWith('organizacao_id', ORG_ID);
    // The malformed row (invalid UUID) is dropped rather than surfaced to the client.
    expect(body.membros).toEqual([{ user_id: ACTOR_ID, papel: 'owner', created_at: '2026-08-01T00:00:00Z' }]);
  });

  it('returns 500 when the membership store fails', async () => {
    verifySessionAndRoleMock.mockResolvedValue({ actorId: ACTOR_ID });
    verifyOrganizationScopeMock.mockResolvedValue({
      _tag: 'OrganizationScopeVerified',
      scope: { organizationId: ORG_ID, actorId: ACTOR_ID, role: 'owner' },
    });
    orderMock.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(500);
  });
});
