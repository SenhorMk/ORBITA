/**
 * Ticket 22, fatia A — regressão de fronteira das rotas migradas.
 *
 * As suítes existentes destas rotas testam o **handler** (`createPedidoStatusHandler`
 * e companhia), não a fiação da rota. Por isso a troca do portão de autorização
 * passou com 1.199 testes verdes sem que nenhum deles olhasse para ela — a
 * família de defeito nº 1: fronteira testada de um lado só.
 *
 * Aqui a autorização é atravessada de verdade: provedor de identidade e
 * `membros_organizacao` são dublês fiéis à forma real, e nada é substituído por
 * um retorno pronto. Uma por classe de mudança:
 *
 * - portão puro removido           → `bling/situacoes`
 * - `session.role` virou capacidade → `produtos/delete`
 * - `tenant.id` virou `scope.actorId` → `pedidos/status`
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ORG_ID = '20000000-0000-4000-8000-000000000001';
const OWNER_ID = '30000000-0000-4000-8000-000000000001';
const MEMBER_ID = '30000000-0000-4000-8000-000000000002';

const getUserMock = vi.fn();
const contextoAtivoMock = vi.fn();
const vinculoMock = vi.fn();
const obterSituacoesMock = vi.fn();
const criarHandlerPedidoStatusMock = vi.fn();

/**
 * Dublê do PostgREST no formato que `SupabaseOrganizationMemberships` usa:
 * primeiro o contexto ativo, depois o vínculo com a organização embutida.
 */
vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    auth: { getUser: getUserMock },
    from: (tabela: string) => ({
      select: () => {
        if (tabela === 'contextos_organizacao_ativos') {
          return { eq: () => ({ maybeSingle: contextoAtivoMock }) };
        }
        const alvo = {
          eq: () => alvo,
          order: () => alvo,
          limit: () => alvo,
          maybeSingle: vinculoMock,
        };
        return alvo;
      },
    }),
  },
}));
vi.mock('@/services/bling', () => ({
  bling: { forVerifiedOrganization: () => ({ obterSituacoesDePedidoDeVenda: obterSituacoesMock }) },
}));

function sessaoDe(userId: string) {
  getUserMock.mockResolvedValue({
    data: { user: { id: userId, app_metadata: { provider: 'email', providers: ['email'] } } },
    error: null,
  });
}

function vinculoDe(papel: 'owner' | 'admin' | 'member' | null) {
  contextoAtivoMock.mockResolvedValue({ data: null, error: null });
  vinculoMock.mockResolvedValue({
    data: papel === null ? null : {
      papel,
      organizacao_id: ORG_ID,
      organizacoes: {
        id: ORG_ID,
        nome: 'Organização de teste',
        slug: 'org-teste',
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-01T00:00:00Z',
      },
    },
    error: null,
  });
}

function requisicao(url: string, metodo = 'GET', autorizada = true, corpo?: unknown): Request {
  return new Request(url, {
    method: metodo,
    headers: {
      ...(autorizada ? { Authorization: 'Bearer token-de-sessao' } : {}),
      'Content-Type': 'application/json',
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
}

describe('GET /api/bling/situacoes — portão puro removido', () => {
  beforeEach(() => vi.clearAllMocks());

  it('devolve 401 sem sessão', async () => {
    const { GET } = await import('./bling/situacoes/route');
    expect((await GET(requisicao('https://orbita.test/api/bling/situacoes', 'GET', false))).status).toBe(401);
    expect(obterSituacoesMock).not.toHaveBeenCalled();
  });

  it('devolve 403 a quem está autenticado e não tem vínculo', async () => {
    sessaoDe(OWNER_ID);
    vinculoDe(null);
    const { GET } = await import('./bling/situacoes/route');
    expect((await GET(requisicao('https://orbita.test/api/bling/situacoes'))).status).toBe(403);
    expect(obterSituacoesMock).not.toHaveBeenCalled();
  });

  // Era a rota que o modelo antigo deixava passar por `app_metadata` e o novo
  // negava logo depois; agora a resposta é a mesma pergunta, feita uma vez só.
  it('responde ao membro, que não precisa de gestão para ler situações', async () => {
    sessaoDe(MEMBER_ID);
    vinculoDe('member');
    obterSituacoesMock.mockResolvedValue({ _tag: 'BlingOk', value: [{ id: 9, nome: 'Em aberto' }] });
    const { GET } = await import('./bling/situacoes/route');
    expect((await GET(requisicao('https://orbita.test/api/bling/situacoes'))).status).toBe(200);
  });

  // Ticket 31 — o status da rota diz de quem é o problema.
  //
  // `502` para toda falha era largo demais: alerta que classifica 5xx como
  // indisponibilidade do provedor acusaria o Bling fora do ar em casos onde
  // ele respondeu 200 a tudo, e o diagnóstico começaria no lugar errado.
  it('devolve 502 quando o Bling recusou de verdade', async () => {
    sessaoDe(MEMBER_ID);
    vinculoDe('member');
    obterSituacoesMock.mockResolvedValue({
      _tag: 'BlingFailed',
      failure: { _tag: 'BlingProviderFailure', type: 'HTTP_503', status: 503, message: 'indisponível', duplicateSale: false },
    });
    const { GET } = await import('./bling/situacoes/route');
    expect((await GET(requisicao('https://orbita.test/api/bling/situacoes'))).status).toBe(502);
  });

  it('devolve 500 quando a falha é deste lado, e não do Bling', async () => {
    // Módulo de vendas não identificado: o Bling respondeu 200 a tudo, e o
    // status da falha é o da leitura que deu certo.
    sessaoDe(MEMBER_ID);
    vinculoDe('member');
    obterSituacoesMock.mockResolvedValue({
      _tag: 'BlingFailed',
      failure: { _tag: 'BlingProviderFailure', type: 'RESOURCE_NOT_FOUND', status: 200, message: 'módulo não identificado', duplicateSale: false },
    });
    const { GET } = await import('./bling/situacoes/route');
    expect((await GET(requisicao('https://orbita.test/api/bling/situacoes'))).status).toBe(500);
  });
});

describe('POST /api/produtos/delete — papel legado virou capacidade', () => {
  beforeEach(() => vi.clearAllMocks());

  const url = 'https://orbita.test/api/produtos/delete';

  it('devolve 401 sem sessão', async () => {
    const { POST } = await import('./produtos/delete/route');
    expect((await POST(requisicao(url, 'POST', false, { id: 'p1' }))).status).toBe(401);
  });

  it('nega o membro com 403, por capacidade e não por papel de `app_metadata`', async () => {
    sessaoDe(MEMBER_ID);
    vinculoDe('member');
    const { POST } = await import('./produtos/delete/route');
    const resposta = await POST(requisicao(url, 'POST', true, { id: 'p1' }));
    expect(resposta.status).toBe(403);
  });

  // O modelo antigo só reconhecia `dono`. Quem administra a organização como
  // `admin` era negado, embora administre — o papel lido era o errado.
  it('deixa o admin passar da autorização, o que o papel legado impedia', async () => {
    sessaoDe(OWNER_ID);
    vinculoDe('admin');
    const { POST } = await import('./produtos/delete/route');
    const resposta = await POST(requisicao(url, 'POST', true, {}));
    // Sem `id` no corpo a rota responde 400 — e chegar ao 400 já prova que a
    // autorização deixou passar.
    expect(resposta.status).toBe(400);
  });
});

describe('POST /api/pedidos/status — o ator vem do vínculo, não do tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    criarHandlerPedidoStatusMock.mockReturnValue(async () => new Response('{}', { status: 200 }));
  });

  it('devolve 401 sem sessão', async () => {
    const { POST } = await import('./pedidos/status/route');
    expect((await POST(requisicao('https://orbita.test/api/pedidos/status', 'POST', false, {}))).status).toBe(401);
  });

  it('passa `scope.actorId` como ator — o id do usuário, não o do tenant', async () => {
    vi.resetModules();
    vi.doMock('@/app/api/pedidos/status/handler', async () => {
      const real = await vi.importActual<typeof import('@/app/api/pedidos/status/handler')>('@/app/api/pedidos/status/handler');
      return { ...real, createPedidoStatusHandler: criarHandlerPedidoStatusMock };
    });
    sessaoDe(MEMBER_ID);
    vinculoDe('member');

    const { POST } = await import('./pedidos/status/route');
    await POST(requisicao('https://orbita.test/api/pedidos/status', 'POST', true, {}));

    expect(criarHandlerPedidoStatusMock).toHaveBeenCalledTimes(1);
    const deps = criarHandlerPedidoStatusMock.mock.calls[0]![0] as {
      auth: { authenticate: () => Promise<{ actorId: string }> };
    };
    await expect(deps.auth.authenticate()).resolves.toEqual({ actorId: MEMBER_ID });
    vi.doUnmock('@/app/api/pedidos/status/handler');
  });
});
