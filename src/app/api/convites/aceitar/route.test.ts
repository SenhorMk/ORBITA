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
    expect(body.contexto).toBe('organizacao_ativada');
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
    expect(body.contexto).toBe('selecao_anterior_preservada');
    // Nenhum aviso: preservar a seleção válida é o servidor funcionando, e não
    // um resultado parcial que a pessoa precise reconciliar.
    expect(body.aviso).toBeUndefined();
    // O cookie não é gravado: um cookie apontando para a organização nova
    // enquanto o servidor mantém a anterior seria uma segunda fonte divergente.
    expect(cookiesGravados).toEqual([]);
  });

  /*
   * As duas saídas abaixo são a lacuna que a revisão externa da PR #84
   * encontrou. Elas caíam no mesmo corpo do caso `Stale`, e o cliente lia
   * "aceito, e a sua seleção anterior foi preservada" — quando na verdade
   * ninguém sabe qual é a seleção. Como o convite JÁ FOI consumido antes deste
   * segundo passo, a resposta não pode induzir a repetir o token.
   */
  it.each([
    ['OrganizationSwitchDenied', { _tag: 'OrganizationSwitchDenied' }],
    ['MembershipStoreUnavailable', { _tag: 'MembershipStoreUnavailable', cause: 'membership_store_unreachable' }],
  ])('devolve estado parcial explicito quando o CAS responde %s depois do aceite', async (_nome, saida) => {
    getUserMock.mockResolvedValue({
      data: {
        user: { id: NOVO_MEMBRO_ID, app_metadata: { provider: 'email', providers: ['email'] } },
      },
      error: null,
    });
    acceptOrgInviteMock.mockResolvedValue({ organizacaoId: ORG_ID });
    const { deps, cookiesGravados } = seams(saida);

    const { createAcceptInviteHandler } = await import('./route');
    const response = await createAcceptInviteHandler(deps)(request());
    const body = await response.json();

    // A primeira etapa commitou: negar isso mandaria a pessoa tentar de novo.
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.organizacaoId).toBe(ORG_ID);

    // E a segunda não terminou: dizer que terminou mandaria procurar a
    // organização ativa onde ela não está.
    expect(body.contexto).toBe('nao_resolvido');
    expect(body.aviso).toMatch(/convite aceito/i);
    expect(body.aviso).toMatch(/não use o código de novo/i);

    // Nenhum cookie: o servidor não aplicou seleção nenhuma.
    expect(cookiesGravados).toEqual([]);

    // E nada do diagnóstico interno vaza para o cliente.
    expect(JSON.stringify(body)).not.toContain('membership_store_unreachable');
    expect(JSON.stringify(body)).not.toContain(saida._tag);
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
