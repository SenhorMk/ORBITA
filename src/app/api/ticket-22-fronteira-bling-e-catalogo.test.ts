/**
 * Ticket 22, critério 14 — regressão de fronteira do **Bling e do catálogo**.
 *
 * Cinco handlers, nominalmente: `GET`, `DELETE` e `PUT` de
 * `/api/bling/pedidos/[id]`, e `GET` e `POST` de `/api/categorias/sync`.
 *
 * São os cinco da fatia B, os que não trocaram só o portão: os ports deles
 * recebiam o `tenant` do modelo por usuário, resolvido de `app_metadata`, e
 * passaram a receber a organização verificada. `categorias/sync` POST era o
 * caso pior — escrevia `user_id: tenant.id` num caminho de escrita.
 *
 * Aqui entra também a política de ocultação do ticket 04: pedido de outra
 * organização responde **404**, não 403, e a resposta é indistinguível de um
 * pedido que nunca existiu.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  FronteiraDeAutorizacao,
  requisicao,
  ADMIN_ID,
  MEMBER_ID,
  ORG_ID,
  OWNER_ID,
} from './__testkit__/fronteiraDeAutorizacao';

const fronteira = new FronteiraDeAutorizacao();
const getByBlingIdMock = vi.fn();
const deleteByBlingIdMock = vi.fn();
const getPedidoMock = vi.fn();
const updatePedidoMock = vi.fn();
const deletePedidoMock = vi.fn();
const getCategoriasProdutosMock = vi.fn();
const forVerifiedOrganizationMock = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  get supabaseServer() {
    return fronteira.supabaseServer;
  },
}));
vi.mock('@/services/bling', () => ({
  bling: {
    forVerifiedOrganization: (escopo: unknown) => {
      forVerifiedOrganizationMock(escopo);
      return {
        getPedido: getPedidoMock,
        updatePedido: updatePedidoMock,
        deletePedido: deletePedidoMock,
        getCategoriasProdutos: getCategoriasProdutosMock,
      };
    },
  },
}));
vi.mock('@/repositories/pedidoRepository', () => ({
  pedidoRepository: { getByBlingId: getByBlingIdMock, deleteByBlingId: deleteByBlingIdMock },
}));

const PEDIDO_ID = '26735988980';
const URL_PEDIDO = `https://orbita.test/api/bling/pedidos/${PEDIDO_ID}`;
const URL_CATEGORIAS = 'https://orbita.test/api/categorias/sync';

const contexto = () => ({ params: Promise.resolve({ id: PEDIDO_ID }) });

/**
 * As cinco negações que todo handler desta fatia preserva.
 *
 * Compartilhar o corpo não dilui a cobertura: cada handler é registrado pelo
 * próprio nome e chama a própria rota. Arrancar a autorização de um deixa
 * vermelho o bloco dele, e só ele.
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
      expect(getByBlingIdMock).not.toHaveBeenCalled();
    });
  });
}

negacoesDaFronteira('GET /api/bling/pedidos/[id]', async (autorizada = true) => {
  const { GET } = await import('./bling/pedidos/[id]/route');
  return GET(requisicao(URL_PEDIDO, { autorizada }), contexto());
});

negacoesDaFronteira('DELETE /api/bling/pedidos/[id]', async (autorizada = true) => {
  const { DELETE } = await import('./bling/pedidos/[id]/route');
  return DELETE(requisicao(URL_PEDIDO, { metodo: 'DELETE', autorizada }), contexto());
});

negacoesDaFronteira('PUT /api/bling/pedidos/[id]', async (autorizada = true) => {
  const { PUT } = await import('./bling/pedidos/[id]/route');
  return PUT(requisicao(URL_PEDIDO, { metodo: 'PUT', autorizada, corpo: { numero: '1' } }), contexto());
});

negacoesDaFronteira('GET /api/categorias/sync', async (autorizada = true) => {
  const { GET } = await import('./categorias/sync/route');
  return GET(requisicao(URL_CATEGORIAS, { autorizada }));
});

negacoesDaFronteira('POST /api/categorias/sync', async (autorizada = true) => {
  const { POST } = await import('./categorias/sync/route');
  return POST(requisicao(URL_CATEGORIAS, { metodo: 'POST', autorizada, corpo: {} }));
});

describe('GET /api/bling/pedidos/[id] — ler não exige gestão, e o escopo isola', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo();
  });

  it('responde ao membro, com o pedido buscado no escopo do vínculo', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');
    getByBlingIdMock.mockResolvedValue({ bling_id: PEDIDO_ID });
    getPedidoMock.mockResolvedValue({ id: PEDIDO_ID });

    const { GET } = await import('./bling/pedidos/[id]/route');
    const resposta = await GET(requisicao(URL_PEDIDO), contexto());

    expect(resposta.status).toBe(200);
    expect(getByBlingIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, actorId: MEMBER_ID }),
      PEDIDO_ID,
    );
  });

  // Política do ticket 04, preservada: o id do pedido vem do caminho, e é
  // entrada do cliente. Um pedido de outra organização não é achado no escopo,
  // e a resposta é **a mesma** de um pedido inexistente — 404 e o mesmo corpo.
  it('esconde o pedido de outra organização atrás do mesmo 404 do inexistente', async () => {
    fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
    getByBlingIdMock.mockResolvedValue(null);

    const { GET } = await import('./bling/pedidos/[id]/route');
    const deOutraOrganizacao = await GET(requisicao(URL_PEDIDO), contexto());
    const inexistente = await GET(requisicao(URL_PEDIDO), contexto());

    expect(deOutraOrganizacao.status).toBe(404);
    expect(await deOutraOrganizacao.json()).toEqual(await inexistente.json());
    // Nada foi perguntado ao Bling: a existência lá fora não vaza pela resposta.
    expect(getPedidoMock).not.toHaveBeenCalled();
  });
});

describe('DELETE e PUT /api/bling/pedidos/[id] — escrever exige gestão', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo();
  });

  it('DELETE: nega o membro com 403, sem tocar no pedido', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');

    const { DELETE } = await import('./bling/pedidos/[id]/route');
    expect((await DELETE(requisicao(URL_PEDIDO, { metodo: 'DELETE' }), contexto())).status).toBe(403);
    expect(getByBlingIdMock).not.toHaveBeenCalled();
    expect(deletePedidoMock).not.toHaveBeenCalled();
  });

  it('DELETE: o admin apaga, no escopo do vínculo', async () => {
    fronteira.sessaoDe(ADMIN_ID).vinculoDe('admin');
    getByBlingIdMock.mockResolvedValue({ bling_id: PEDIDO_ID });
    deletePedidoMock.mockResolvedValue(undefined);
    deleteByBlingIdMock.mockResolvedValue(undefined);

    const { DELETE } = await import('./bling/pedidos/[id]/route');
    expect((await DELETE(requisicao(URL_PEDIDO, { metodo: 'DELETE' }), contexto())).status).toBe(200);
    expect(deleteByBlingIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, actorId: ADMIN_ID }),
      PEDIDO_ID,
    );
  });

  it('PUT: nega o membro com 403, sem ler o corpo nem tocar no pedido', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');

    const { PUT } = await import('./bling/pedidos/[id]/route');
    const resposta = await PUT(requisicao(URL_PEDIDO, { metodo: 'PUT', corpo: { numero: '1' } }), contexto());

    expect(resposta.status).toBe(403);
    expect(updatePedidoMock).not.toHaveBeenCalled();
  });

  it('PUT: o owner altera, no escopo do vínculo', async () => {
    fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
    getByBlingIdMock.mockResolvedValue({ bling_id: PEDIDO_ID });
    updatePedidoMock.mockResolvedValue({ id: PEDIDO_ID });

    const { PUT } = await import('./bling/pedidos/[id]/route');
    const resposta = await PUT(requisicao(URL_PEDIDO, { metodo: 'PUT', corpo: { numero: '7' } }), contexto());

    expect(resposta.status).toBe(200);
    expect(forVerifiedOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, actorId: OWNER_ID }),
    );
  });
});

describe('GET e POST /api/categorias/sync — ler é acesso, sincronizar é gestão', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo();
  });

  it('GET: o membro lista o catálogo da organização do vínculo', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member').tabela('categorias', { data: [], error: null });

    const { GET } = await import('./categorias/sync/route');
    expect((await GET(requisicao(URL_CATEGORIAS))).status).toBe(200);
  });

  // Era o caminho de escrita que ainda gravava `user_id: tenant.id`. Um membro
  // não sincroniza, e a negação vem da capacidade — não de `app_metadata`.
  it('POST: nega o membro com 403, sem ler nada do Bling', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');

    const { POST } = await import('./categorias/sync/route');
    expect((await POST(requisicao(URL_CATEGORIAS, { metodo: 'POST', corpo: {} }))).status).toBe(403);
    expect(getCategoriasProdutosMock).not.toHaveBeenCalled();
  });

  it('POST: o admin sincroniza, com o cliente do Bling preso à organização do vínculo', async () => {
    fronteira.sessaoDe(ADMIN_ID).vinculoDe('admin').tabela('categorias', { data: [], error: null });
    getCategoriasProdutosMock.mockResolvedValue([]);

    const { POST } = await import('./categorias/sync/route');
    const resposta = await POST(requisicao(URL_CATEGORIAS, { metodo: 'POST', corpo: {} }));

    expect(resposta.status).toBe(200);
    expect(forVerifiedOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, actorId: ADMIN_ID }),
    );
  });
});
