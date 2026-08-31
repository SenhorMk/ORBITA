/**
 * Ticket 20 — este teste passou a atravessar a autorização real.
 *
 * Antes ele fabricava a sessão (`verifySessionAndRoleMock.mockResolvedValue({ actorId })`),
 * então ficava verde enquanto a rota, em produção, negava com 401 qualquer
 * chamador — inclusive o dono. Nenhum usuário deste aplicativo tem papel dentro
 * de `app_metadata`, que era o que o atalho lia.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORG_ID = '20000000-0000-4000-8000-000000000001';
const ACTOR_ID = '30000000-0000-4000-8000-000000000001';

const getUserMock = vi.fn();
const maybeSingleMock = vi.fn();
const orderMock = vi.fn();
const eqMock = vi.fn(() => ({
  eq: () => ({ maybeSingle: maybeSingleMock }),
  order: orderMock,
}));
const selectMock = vi.fn(() => ({ eq: eqMock }));
const fromMock = vi.fn(() => ({ select: selectMock }));

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: { auth: { getUser: getUserMock }, from: fromMock },
}));

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
  return new Request(`https://orbita.test/api/organizacoes/${ORG_ID}/membros`, {
    method: 'GET',
    headers: authorized ? { Authorization: 'Bearer token-de-sessao' } : {},
  });
}

const params = () => ({ params: Promise.resolve({ id: ORG_ID }) });

describe('GET /api/organizacoes/[id]/membros', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devolve 401 sem sessão', async () => {
    const { GET } = await import('./route');

    const response = await GET(request(false), params());

    expect(response.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('nega com 403 quem não tem vínculo com a organização', async () => {
    sessionOf(ACTOR_ID);
    membershipOf(null);
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(403);
    expect(orderMock).not.toHaveBeenCalled();
  });

  it('lista os membros para quem tem vínculo, mesmo sem papel de gestão', async () => {
    sessionOf(ACTOR_ID);
    membershipOf('member');
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
    // A linha malformada (UUID inválido) é descartada em vez de chegar ao cliente.
    expect(body.membros).toEqual([{ user_id: ACTOR_ID, papel: 'owner', created_at: '2026-08-01T00:00:00Z' }]);
  });

  it('devolve 500 quando a leitura da lista falha', async () => {
    sessionOf(ACTOR_ID);
    membershipOf('owner');
    orderMock.mockResolvedValue({ data: null, error: { message: 'db down' } });
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
  });
});
