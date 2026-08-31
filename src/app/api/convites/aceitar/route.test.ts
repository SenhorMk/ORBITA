/**
 * Regressão de fronteira do Ticket 20 — aceite de convite.
 *
 * O caso que a rota existe para atender é justamente o de quem ainda não tem
 * vínculo com organização nenhuma. O atalho de sessão exigia vínculo, então
 * negava com 401 exatamente esse caso.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const NOVO_MEMBRO_ID = '30000000-0000-4000-8000-000000000003';
const ORG_ID = '20000000-0000-4000-8000-000000000001';

const getUserMock = vi.fn();
const acceptOrgInviteMock = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: { auth: { getUser: getUserMock } },
}));
vi.mock('@/lib/supabaseActorClient', () => ({
  createActorScopedSupabaseClient: () => ({ _tag: 'ActorScopedClientCreated', client: {} }),
}));
vi.mock('@/lib/invitationService', async () => {
  const real = await vi.importActual<typeof import('@/lib/invitationService')>('@/lib/invitationService');
  return { ...real, acceptOrgInvite: acceptOrgInviteMock };
});

function request(authorized = true): Request {
  return new Request('https://orbita.test/api/convites/aceitar', {
    method: 'POST',
    headers: {
      ...(authorized ? { Authorization: 'Bearer token-de-sessao' } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: 'f'.repeat(64) }),
  });
}

describe('POST /api/convites/aceitar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('devolve 401 sem sessão', async () => {
    const { createAcceptInviteHandler } = await import('./route');
    const response = await createAcceptInviteHandler(async () => {})(request(false));
    expect(response.status).toBe(401);
    expect(acceptOrgInviteMock).not.toHaveBeenCalled();
  });

  it('devolve 503 quando o provedor de identidade está indisponível', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'down', status: 503 } });
    const { createAcceptInviteHandler } = await import('./route');
    const response = await createAcceptInviteHandler(async () => {})(request());
    expect(response.status).toBe(503);
    expect(acceptOrgInviteMock).not.toHaveBeenCalled();
  });

  it('aceita o convite de quem está autenticado e ainda não é membro de organização nenhuma', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: { id: NOVO_MEMBRO_ID, app_metadata: { provider: 'email', providers: ['email'] } },
      },
      error: null,
    });
    acceptOrgInviteMock.mockResolvedValue({ organizacaoId: ORG_ID });
    const ativada: string[] = [];

    const { createAcceptInviteHandler } = await import('./route');
    const response = await createAcceptInviteHandler(async (id) => {
      ativada.push(id);
    })(request());

    expect(response.status).toBe(200);
    expect(acceptOrgInviteMock).toHaveBeenCalled();
    expect(ativada).toEqual([ORG_ID]);
  });
});
