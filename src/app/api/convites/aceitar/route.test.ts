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

/** Seams do Ticket 06: a seleção passa pelo CAS, e o cookie espelha o que ele aplicou. */
function seams(
  selecao: { readonly _tag: string; readonly version?: number } = { _tag: 'OrganizationSwitchApplied', version: 1 },
) {
  const cookiesGravados: string[] = [];
  const selecionar = vi.fn(async () => selecao as never);
  return {
    cookiesGravados,
    selecionar,
    deps: {
      selecionarSeNaoHouverSelecao: selecionar,
      gravarCookieDeOrganizacaoAtiva: async (id: string) => { cookiesGravados.push(id); },
    },
  };
}

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
    const response = await createAcceptInviteHandler(seams().deps)(request(false));
    expect(response.status).toBe(401);
    expect(acceptOrgInviteMock).not.toHaveBeenCalled();
  });

  it('devolve 503 quando o provedor de identidade está indisponível', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'down', status: 503 } });
    const { createAcceptInviteHandler } = await import('./route');
    const response = await createAcceptInviteHandler(seams().deps)(request());
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
    const { deps, selecionar, cookiesGravados } = seams();

    const { createAcceptInviteHandler } = await import('./route');
    const response = await createAcceptInviteHandler(deps)(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(acceptOrgInviteMock).toHaveBeenCalled();
    // Quem não tinha seleção nenhuma passa a ter a organização ingressada, e a
    // seleção vai pelo CAS com versão esperada 0 — nunca por escrita direta.
    expect(selecionar).toHaveBeenCalledWith(NOVO_MEMBRO_ID, ORG_ID);
    expect(body.organizacaoAtivada).toBe(true);
    expect(cookiesGravados).toEqual([ORG_ID]);
  });

  it('preserva a seleção ativa válida de quem já estava em outra organização', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: { id: NOVO_MEMBRO_ID, app_metadata: { provider: 'email', providers: ['email'] } },
      },
      error: null,
    });
    acceptOrgInviteMock.mockResolvedValue({ organizacaoId: ORG_ID });
    // O CAS recusa a inserção porque já existe seleção: a organização ativa
    // continua sendo a que estava, e nada é forçado por cima dela.
    const { deps, cookiesGravados } = seams({ _tag: 'OrganizationSwitchStale' });

    const { createAcceptInviteHandler } = await import('./route');
    const response = await createAcceptInviteHandler(deps)(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.organizacaoId).toBe(ORG_ID);
    expect(body.organizacaoAtivada).toBe(false);
    // O cookie não é gravado: um cookie apontando para a organização nova
    // enquanto o servidor mantém a anterior seria uma segunda fonte divergente.
    expect(cookiesGravados).toEqual([]);
  });

  // A resposta é a mesma para toda recusa de propósito: variar por causa diria
  // a quem tenta um token qualquer *por que* aquele token não serve.
  it('não devolve diagnóstico interno nem o motivo da recusa (CWE-209)', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: { id: NOVO_MEMBRO_ID, app_metadata: { provider: 'email', providers: ['email'] } },
      },
      error: null,
    });
    acceptOrgInviteMock.mockRejectedValue(
      Object.assign(new Error('Convite destinado a outro@empresa.com, expirado em 2026-08-01'), { code: 'P0001' }),
    );
    const { createAcceptInviteHandler } = await import('./route');

    const response = await createAcceptInviteHandler(seams().deps)(request());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Não foi possível aceitar o convite');
    expect(JSON.stringify(body)).not.toContain('outro@empresa.com');
    expect(JSON.stringify(body)).not.toContain('expirado');
  });
});
