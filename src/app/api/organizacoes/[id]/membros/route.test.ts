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
const OUTRO_ID = '30000000-0000-4000-8000-000000000002';
const OUTRA_ORG_ID = '20000000-0000-4000-8000-000000000002';

const getUserMock = vi.fn();
const getUserByIdMock = vi.fn();
const maybeSingleMock = vi.fn();
const orderMock = vi.fn();

/**
 * O par (organização, ator) que a última consulta de vínculo filtrou.
 *
 * O dublê registra os dois `.eq` porque o teste cross-tenant precisa **poder
 * falhar**: com um dublê que devolve o mesmo para qualquer argumento, uma rota
 * que buscasse vínculo só pelo ator — e achasse o da organização A — passaria
 * igual. Aí o teste provaria "sem vínculo nenhum é negado", que é outra coisa.
 */
let parConsultado: Record<string, string> = {};
const eqMock = vi.fn((coluna: string, valor: string) => {
  parConsultado[coluna] = valor;
  return {
    eq: (outraColuna: string, outroValor: string) => {
      parConsultado[outraColuna] = outroValor;
      return { maybeSingle: maybeSingleMock };
    },
    order: orderMock,
  };
});
const selectMock = vi.fn(() => ({ eq: eqMock }));
const fromMock = vi.fn(() => ({ select: selectMock }));

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    auth: { getUser: getUserMock, admin: { getUserById: getUserByIdMock } },
    from: fromMock,
  },
}));

/**
 * Identidades do Auth, por id. Quem nao estiver no mapa devolve erro — que e
 * como o Auth responde para um id que ele nao resolve, e e o caminho que
 * precisa virar `origem_do_nome: 'indisponivel'`, e nao "sem nome".
 */
function identidades(porId: Record<string, { email?: string | null; user_metadata?: unknown }>) {
  getUserByIdMock.mockImplementation((id: string) => {
    const usuario = porId[id];
    return Promise.resolve(
      usuario
        ? { data: { user: { id, ...usuario } }, error: null }
        : { data: { user: null }, error: { message: 'User not found' } },
    );
  });
}

function sessionOf(userId: string) {
  getUserMock.mockResolvedValue({
    data: { user: { id: userId, app_metadata: { provider: 'email', providers: ['email'] } } },
    error: null,
  });
}

function membershipOf(papel: 'owner' | 'admin' | 'member' | null) {
  maybeSingleMock.mockResolvedValue({ data: papel === null ? null : { papel }, error: null });
}

/**
 * Vínculos reais, indexados **pelo par** — como a tabela.
 *
 * A consulta só acha linha quando organização e ator batem os dois. É isto que
 * separa "negado porque não tem vínculo" de "negado porque o vínculo é com
 * outra organização".
 */
function membershipsPorPar(porPar: Record<string, 'owner' | 'admin' | 'member'>) {
  maybeSingleMock.mockImplementation(() => {
    const papel = porPar[`${parConsultado.organizacao_id}|${parConsultado.user_id}`];
    return Promise.resolve({ data: papel ? { papel } : null, error: null });
  });
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
    parConsultado = {};
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
    identidades({
      [ACTOR_ID]: { email: 'dona@exemplo.com', user_metadata: { full_name: 'Dona da Loja' } },
      [OUTRO_ID]: { email: 'colega@exemplo.com', user_metadata: { full_name: 'Colega de Balcão' } },
    });
    orderMock.mockResolvedValue({
      data: [
        { user_id: ACTOR_ID, papel: 'owner', created_at: '2026-08-01T00:00:00Z' },
        { user_id: OUTRO_ID, papel: 'member', created_at: '2026-08-02T00:00:00Z' },
      ],
      error: null,
    });
    const { GET } = await import('./route');

    const response = await GET(request(), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fromMock).toHaveBeenCalledWith('membros_organizacao');
    expect(eqMock).toHaveBeenCalledWith('organizacao_id', ORG_ID);
    // O vínculo continua inteiro — `user_id` é a chave da remoção — e agora vem
    // acompanhado de como chamar a pessoa.
    expect(body.membros).toEqual([
      {
        user_id: ACTOR_ID,
        papel: 'owner',
        created_at: '2026-08-01T00:00:00Z',
        nome_exibicao: 'Dona da Loja',
        origem_do_nome: 'cadastro',
      },
      {
        user_id: OUTRO_ID,
        papel: 'member',
        created_at: '2026-08-02T00:00:00Z',
        nome_exibicao: 'Colega de Balcão',
        origem_do_nome: 'cadastro',
      },
    ]);
  });

  it.each(['owner', 'admin', 'member'] as const)(
    'para %s, um membro sem nome cadastrado é dito assim — e nunca pelo e-mail',
    async (papel) => {
      // A regra e uma so para os tres papeis. A revisao externa recusou o
      // recurso ao e-mail para owner/admin: "ja e visivel em outro lugar" nao e
      // motivo para publicar PII em mais um.
      sessionOf(ACTOR_ID);
      membershipOf(papel);
      identidades({
        [ACTOR_ID]: { email: 'quem.olha@exemplo.com', user_metadata: { full_name: 'Quem Olha' } },
        [OUTRO_ID]: { email: 'legado@exemplo.com', user_metadata: {} },
      });
      orderMock.mockResolvedValue({
        data: [
          { user_id: ACTOR_ID, papel, created_at: '2026-08-01T00:00:00Z' },
          { user_id: OUTRO_ID, papel: 'member', created_at: '2026-08-02T00:00:00Z' },
        ],
        error: null,
      });
      const { GET } = await import('./route');

      const body = await (await GET(request(), params())).json();

      expect(body.membros[0]).toMatchObject({ nome_exibicao: 'Quem Olha', origem_do_nome: 'cadastro' });
      expect(body.membros[1]).toMatchObject({ nome_exibicao: null, origem_do_nome: 'ausente' });
      expect(JSON.stringify(body)).not.toContain('legado@exemplo.com');
      expect(JSON.stringify(body)).not.toContain('quem.olha@exemplo.com');
    },
  );

  it('identidade que não pôde ser lida não vira "sem nome" — e não derruba a lista', async () => {
    // As duas metades importam. Dizer "sem nome cadastrado" sobre alguém cuja
    // identidade não foi lida é afirmar um fato que ninguém verificou; e
    // devolver 500 tiraria do ar uma tela de autoridade por causa de uma
    // decoração — o vínculo, que é o dado desta rota, foi lido com sucesso.
    sessionOf(ACTOR_ID);
    membershipOf('owner');
    identidades({ [ACTOR_ID]: { email: 'dona@exemplo.com', user_metadata: { full_name: 'Dona da Loja' } } });
    orderMock.mockResolvedValue({
      data: [
        { user_id: ACTOR_ID, papel: 'owner', created_at: '2026-08-01T00:00:00Z' },
        { user_id: OUTRO_ID, papel: 'member', created_at: '2026-08-02T00:00:00Z' },
      ],
      error: null,
    });
    const { GET } = await import('./route');

    const response = await GET(request(), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.membros).toHaveLength(2);
    expect(body.membros[1]).toMatchObject({ nome_exibicao: null, origem_do_nome: 'indisponivel' });
  });

  it('não devolve a metadata do Auth — nem o e-mail — junto com o membro', async () => {
    sessionOf(ACTOR_ID);
    membershipOf('owner');
    identidades({
      [ACTOR_ID]: {
        email: 'dona@exemplo.com',
        // O saco aberto: qualquer integração pode ter escrito qualquer coisa
        // aqui, e nada disso passou por revisão para virar resposta pública.
        user_metadata: { full_name: 'Dona da Loja', cpf: '000.000.000-00', provider_token: 'segredo' },
      },
    });
    orderMock.mockResolvedValue({
      data: [{ user_id: ACTOR_ID, papel: 'owner', created_at: '2026-08-01T00:00:00Z' }],
      error: null,
    });
    const { GET } = await import('./route');

    const corpo = JSON.stringify(await (await GET(request(), params())).json());

    expect(corpo).toContain('Dona da Loja');
    expect(corpo).not.toContain('user_metadata');
    expect(corpo).not.toContain('000.000.000-00');
    expect(corpo).not.toContain('provider_token');
    // O e-mail nem chega a ser lido do Auth (ver `lerUsuarioDoAuth`), e esta
    // linha e o que avisa se alguem o reintroduzir no caminho.
    expect(corpo).not.toContain('dona@exemplo.com');
  });

  // Uma linha persistida que o servidor não sabe ler é falha do servidor. Se ela
  // sumisse da lista com 200, a tela concluiria que o membro não existe.
  it('falha em vez de omitir um membro cuja linha não passa no contrato', async () => {
    sessionOf(ACTOR_ID);
    membershipOf('owner');
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

    expect(response.status).toBe(500);
    expect(body.membros).toBeUndefined();
  });

  it('não devolve diagnóstico interno quando a leitura falha (CWE-209)', async () => {
    sessionOf(ACTOR_ID);
    membershipOf('owner');
    orderMock.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for relation membros_organizacao', code: '42501' },
    });
    const { GET } = await import('./route');

    const body = await (await GET(request(), params())).json();

    expect(body.error).toBe('Erro interno');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(JSON.stringify(body)).not.toContain('42501');
  });

  // Isolamento cross-tenant de verdade: não é "externo sem vínculo nenhum", é um
  // membro **legítimo da organização A** pedindo a organização B. É este o caso
  // que o `verifyOrganizationScope` filtra pelo par (organização, ator), e a
  // negação é indistinguível de "a organização B não existe".
  it('nega ao membro da organização A o acesso à organização B', async () => {
    sessionOf(ACTOR_ID);
    // O ator é `owner` da organização A **de verdade** — o vínculo existe na
    // tabela. Só não existe para o par pedido na URL. Uma rota que buscasse
    // vínculo apenas pelo ator acharia este e responderia 200.
    membershipsPorPar({ [`${ORG_ID}|${ACTOR_ID}`]: 'owner' });
    const { GET } = await import('./route');

    const resposta = await GET(
      new Request(`https://orbita.test/api/organizacoes/${OUTRA_ORG_ID}/membros`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token-de-sessao' },
      }),
      { params: Promise.resolve({ id: OUTRA_ORG_ID }) },
    );

    expect(resposta.status).toBe(403);
    expect(orderMock).not.toHaveBeenCalled();
    // A consulta filtrou pelo par, com a organização da URL — não só pelo ator.
    expect(parConsultado).toEqual({ organizacao_id: OUTRA_ORG_ID, user_id: ACTOR_ID });
    // A resposta não diz se a organização B existe.
    expect(JSON.stringify(await resposta.json())).not.toContain(OUTRA_ORG_ID);
  });

  it('devolve 503 quando o depósito de vínculos está indisponível', async () => {
    sessionOf(ACTOR_ID);
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const { GET } = await import('./route');

    const response = await GET(request(), params());

    expect(response.status).toBe(503);
  });
});
