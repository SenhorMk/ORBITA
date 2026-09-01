/**
 * Ticket 22, critério 14 — regressão de fronteira do domínio **financeiro**.
 *
 * Quatro handlers, nominalmente: `GET /api/financeiro`,
 * `GET /api/financeiro/fornecedores`, `POST /api/financeiro/fornecedores` e
 * `POST /api/financeiro/sync`.
 *
 * O `GET` e o `POST` de fornecedores moram no mesmo arquivo e **não herdam a
 * decisão um do outro** — o ticket exige a capacidade decidida por handler, e
 * por isso cada um aparece aqui pelo próprio nome. Nenhum dos quatro exige
 * gestão: o vínculo com a organização basta, e é isso que os casos abaixo
 * fixam. O que eles não podem é responder a quem não tem vínculo nenhum.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  FronteiraDeAutorizacao,
  requisicao,
  MEMBER_ID,
  ORG_ID,
  OUTRA_ORG_ID,
  OWNER_ID,
} from './__testkit__/fronteiraDeAutorizacao';

const fronteira = new FronteiraDeAutorizacao();
const forVerifiedOrganizationMock = vi.fn();
const getClientesMock = vi.fn();
const createContatoMock = vi.fn();
const getResumoMock = vi.fn();
const getTitulosFiltroMock = vi.fn();
const getCategoriasMock = vi.fn();
const criarHandlerSyncFinanceiroMock = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  get supabaseServer() {
    return fronteira.supabaseServer;
  },
}));
vi.mock('@/services/bling', () => ({
  bling: {
    forVerifiedOrganization: (escopo: unknown) => {
      forVerifiedOrganizationMock(escopo);
      return { getClientes: getClientesMock, createContato: createContatoMock };
    },
  },
}));
vi.mock('@/repositories/financeiroRepository', () => ({
  financeiroRepository: {
    getResumo: getResumoMock,
    getTitulosFiltro: getTitulosFiltroMock,
    getCategorias: getCategoriasMock,
    upsertTitulo: vi.fn(),
  },
}));

const URL_FINANCEIRO = 'https://orbita.test/api/financeiro';
const URL_FORNECEDORES = 'https://orbita.test/api/financeiro/fornecedores';
const URL_SYNC = 'https://orbita.test/api/financeiro/sync';

/**
 * As quatro negações que toda rota desta fatia deve preservar.
 *
 * O corpo do teste é compartilhado, mas **cada handler é registrado pelo
 * próprio nome** e chama a própria rota: arrancar a autorização de um só deles
 * deixa vermelho exatamente o bloco dele.
 */
function negacoesDaFronteira(nome: string, chamar: (autorizada?: boolean) => Promise<Response>) {
  describe(`${nome} — negações da fronteira`, () => {
    beforeEach(() => {
      vi.clearAllMocks();
      fronteira.semVinculo();
    });

    it('devolve 401 sem sessão', async () => {
      expect((await chamar(false)).status).toBe(401);
    });

    it('devolve 401 quando o provedor recusa o token', async () => {
      fronteira.sessaoInvalida();
      expect((await chamar()).status).toBe(401);
    });

    it('devolve 503, e não 401, quando o provedor de identidade está fora do ar', async () => {
      fronteira.provedorDeIdentidadeIndisponivel();
      expect((await chamar()).status).toBe(503);
    });

    it('devolve 503, e não 403, quando o depósito de vínculos está indisponível', async () => {
      fronteira.sessaoDe(OWNER_ID).depositoDeVinculosIndisponivel();
      expect((await chamar()).status).toBe(503);
    });

    it('devolve 403 a quem está autenticado e não tem vínculo', async () => {
      fronteira.sessaoDe(OWNER_ID).semVinculo();
      expect((await chamar()).status).toBe(403);
    });
  });
}

negacoesDaFronteira('GET /api/financeiro', async (autorizada = true) => {
  const { GET } = await import('./financeiro/route');
  return GET(requisicao(URL_FINANCEIRO, { autorizada }));
});

negacoesDaFronteira('GET /api/financeiro/fornecedores', async (autorizada = true) => {
  const { GET } = await import('./financeiro/fornecedores/route');
  return GET(requisicao(URL_FORNECEDORES, { autorizada }));
});

negacoesDaFronteira('POST /api/financeiro/fornecedores', async (autorizada = true) => {
  const { POST } = await import('./financeiro/fornecedores/route');
  return POST(requisicao(URL_FORNECEDORES, { metodo: 'POST', autorizada, corpo: { cnpj: '1', nome: 'F' } }));
});

negacoesDaFronteira('POST /api/financeiro/sync', async (autorizada = true) => {
  const { POST } = await import('./financeiro/sync/route');
  return POST(requisicao(URL_SYNC, { metodo: 'POST', autorizada, corpo: {} }));
});

describe('GET /api/financeiro — o membro lê, e o escopo vem do vínculo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo();
  });

  it('responde ao membro: ler o financeiro não exige gestão', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');
    getResumoMock.mockResolvedValue({});
    getTitulosFiltroMock.mockResolvedValue([]);
    getCategoriasMock.mockResolvedValue([]);

    const { GET } = await import('./financeiro/route');
    expect((await GET(requisicao(URL_FINANCEIRO))).status).toBe(200);
  });

  it('consulta o repositório com a organização e o ator do vínculo', async () => {
    fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
    getResumoMock.mockResolvedValue({});
    getTitulosFiltroMock.mockResolvedValue([]);
    getCategoriasMock.mockResolvedValue([]);

    const { GET } = await import('./financeiro/route');
    await GET(requisicao(URL_FINANCEIRO));

    for (const consulta of [getResumoMock, getTitulosFiltroMock, getCategoriasMock]) {
      expect(consulta.mock.calls[0]![0]).toMatchObject({
        organizationId: ORG_ID,
        actorId: OWNER_ID,
        role: 'owner',
      });
    }
  });

  // Isolamento: a organização é do vínculo, e a query string é entrada do
  // cliente. Nenhum parâmetro de URL pode redirecionar a leitura.
  it('ignora a organização vinda na query string', async () => {
    fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
    getResumoMock.mockResolvedValue({});
    getTitulosFiltroMock.mockResolvedValue([]);
    getCategoriasMock.mockResolvedValue([]);

    const { GET } = await import('./financeiro/route');
    await GET(requisicao(`${URL_FINANCEIRO}?organizacao_id=${OUTRA_ORG_ID}&tipo=pagar`));

    expect(getResumoMock.mock.calls[0]![0]).toMatchObject({ organizationId: ORG_ID });
  });
});

describe('GET e POST /api/financeiro/fornecedores — dois handlers, duas decisões', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo();
  });

  it('GET: o membro lista fornecedores, com o cliente do Bling preso ao vínculo', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');
    getClientesMock.mockResolvedValue([]);

    const { GET } = await import('./financeiro/fornecedores/route');
    expect((await GET(requisicao(URL_FORNECEDORES))).status).toBe(200);
    expect(forVerifiedOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, actorId: MEMBER_ID }),
    );
  });

  it('POST: a autorização passa antes da validação do corpo', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');

    const { POST } = await import('./financeiro/fornecedores/route');
    const resposta = await POST(requisicao(URL_FORNECEDORES, { metodo: 'POST', corpo: {} }));

    // 400 por falta de CNPJ e nome — chegar até aqui prova que a autorização
    // deixou passar, e que ela acontece **antes** de ler o corpo.
    expect(resposta.status).toBe(400);
    expect(createContatoMock).not.toHaveBeenCalled();
  });

  it('POST: cria o contato com o cliente do Bling preso à organização do vínculo', async () => {
    fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
    createContatoMock.mockResolvedValue({ id: 1 });

    const { POST } = await import('./financeiro/fornecedores/route');
    const resposta = await POST(
      requisicao(URL_FORNECEDORES, { metodo: 'POST', corpo: { cnpj: '123', nome: 'Fornecedor' } }),
    );

    expect(resposta.status).toBe(200);
    expect(forVerifiedOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, actorId: OWNER_ID }),
    );
  });
});

describe('POST /api/financeiro/sync — o ator vem do vínculo, não do tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo();
  });

  it('passa ao serviço o `actorId` do usuário e a organização do vínculo', async () => {
    vi.resetModules();
    vi.doMock('@/app/api/financeiro/sync/handler', async () => {
      const real = await vi.importActual<typeof import('@/app/api/financeiro/sync/handler')>(
        '@/app/api/financeiro/sync/handler',
      );
      return { ...real, createFinanceiroSyncHandler: criarHandlerSyncFinanceiroMock };
    });
    criarHandlerSyncFinanceiroMock.mockReturnValue(async () => new Response('{}', { status: 200 }));
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');

    const { POST } = await import('./financeiro/sync/route');
    await POST(requisicao(URL_SYNC, { metodo: 'POST', corpo: {} }));

    expect(criarHandlerSyncFinanceiroMock).toHaveBeenCalledTimes(1);
    const deps = criarHandlerSyncFinanceiroMock.mock.calls[0]![0] as {
      auth: {
        authenticate: () => Promise<{ actorId: string }>;
        resolveScope: () => Promise<{ scope: { organizationId: string; actorId: string } }>;
      };
    };
    await expect(deps.auth.authenticate()).resolves.toEqual({ actorId: MEMBER_ID });
    const { scope } = await deps.auth.resolveScope();
    expect(scope).toMatchObject({ organizationId: ORG_ID, actorId: MEMBER_ID });
    vi.doUnmock('@/app/api/financeiro/sync/handler');
  });
});
