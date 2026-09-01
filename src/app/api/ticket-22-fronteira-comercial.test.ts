/**
 * Ticket 22, critério 14 — regressão de fronteira do domínio **comercial**.
 *
 * Dois handlers, nominalmente: `POST /api/clientes/delete` e
 * `POST /api/pedidos/manual`. Os dois foram migrados pela mesma troca mecânica
 * da fatia A, e até aqui estavam cobertos só por typecheck e pela guarda de
 * fronteira — nenhum teste atravessava a autorização deles.
 *
 * O que estes casos exercitam é a **ligação**: a rota importada de verdade, a
 * cadeia real de `resolveVerifiedOrganizationScope`, e o provedor de identidade
 * e o `membros_organizacao` como dublês fiéis à forma. Nenhum papel é
 * fabricado, nenhuma sessão chega pronta. Arranque a autorização de qualquer
 * uma das duas rotas e os casos abaixo ficam vermelhos.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  FronteiraDeAutorizacao,
  requisicao,
  ADMIN_ID,
  MEMBER_ID,
  ORG_ID,
  OUTRA_ORG_ID,
  OWNER_ID,
} from './__testkit__/fronteiraDeAutorizacao';

const fronteira = new FronteiraDeAutorizacao();
const deleteContatoMock = vi.fn();
const deleteClienteMock = vi.fn();
const criarHandlerVendaManualMock = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  get supabaseServer() {
    return fronteira.supabaseServer;
  },
}));
vi.mock('@/services/bling', () => ({
  bling: { forVerifiedOrganization: () => ({ deleteContato: deleteContatoMock }) },
}));
vi.mock('@/repositories/clienteRepository', () => ({
  clienteRepository: { delete: deleteClienteMock },
}));

const URL_CLIENTES = 'https://orbita.test/api/clientes/delete';
const URL_VENDA = 'https://orbita.test/api/pedidos/manual';

describe('POST /api/clientes/delete — apagar exige gestão na organização', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo();
  });

  async function chamar(corpo: unknown, autorizada = true) {
    const { POST } = await import('./clientes/delete/route');
    return POST(requisicao(URL_CLIENTES, { metodo: 'POST', autorizada, corpo }));
  }

  it('devolve 401 sem sessão, e não toca no cliente', async () => {
    const resposta = await chamar({ id: 'c1', bling_id: '123' }, false);

    expect(resposta.status).toBe(401);
    expect(deleteClienteMock).not.toHaveBeenCalled();
    expect(deleteContatoMock).not.toHaveBeenCalled();
  });

  // 401 por ausência e 401 por recusa são a mesma resposta de propósito: nenhuma
  // das duas conta ao chamador se o token existia.
  it('devolve 401 quando o provedor recusa o token', async () => {
    fronteira.sessaoInvalida();

    expect((await chamar({ id: 'c1', bling_id: '123' })).status).toBe(401);
    expect(deleteClienteMock).not.toHaveBeenCalled();
  });

  it('devolve 503, e não 401, quando o provedor de identidade está fora do ar', async () => {
    fronteira.provedorDeIdentidadeIndisponivel();

    expect((await chamar({ id: 'c1', bling_id: '123' })).status).toBe(503);
    expect(deleteClienteMock).not.toHaveBeenCalled();
  });

  it('devolve 503, e não 403, quando o depósito de vínculos está indisponível', async () => {
    fronteira.sessaoDe(OWNER_ID).depositoDeVinculosIndisponivel();

    expect((await chamar({ id: 'c1', bling_id: '123' })).status).toBe(503);
    expect(deleteClienteMock).not.toHaveBeenCalled();
  });

  it('devolve 403 a quem está autenticado e não tem vínculo', async () => {
    fronteira.sessaoDe(OWNER_ID).semVinculo();

    expect((await chamar({ id: 'c1', bling_id: '123' })).status).toBe(403);
    expect(deleteClienteMock).not.toHaveBeenCalled();
  });

  // O papel legado só conhecia `dono`. A pergunta certa é a capacidade nesta
  // organização, e `member` não a tem.
  it('nega o membro com 403, por capacidade e não por papel de `app_metadata`', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');

    expect((await chamar({ id: 'c1', bling_id: '123' })).status).toBe(403);
    expect(deleteClienteMock).not.toHaveBeenCalled();
  });

  it('deixa o admin passar — o papel legado o negava, embora ele administre', async () => {
    fronteira.sessaoDe(ADMIN_ID).vinculoDe('admin');
    deleteContatoMock.mockResolvedValue(undefined);
    deleteClienteMock.mockResolvedValue(undefined);

    expect((await chamar({ id: 'c1', bling_id: '123' })).status).toBe(200);
  });

  // Caminho positivo: o serviço recebe a organização e o ator **derivados do
  // vínculo**, não do corpo da requisição.
  it('entrega ao repositório o escopo do vínculo, e o ator é o usuário', async () => {
    fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
    deleteContatoMock.mockResolvedValue(undefined);
    deleteClienteMock.mockResolvedValue(undefined);

    await chamar({ id: 'c1', bling_id: '123' });

    expect(deleteClienteMock).toHaveBeenCalledTimes(1);
    const [escopo, id] = deleteClienteMock.mock.calls[0]!;
    expect(escopo).toMatchObject({ organizationId: ORG_ID, actorId: OWNER_ID, role: 'owner' });
    expect(id).toBe('c1');
  });

  // Isolamento do recurso: o corpo é entrada não confiável. Uma organização
  // enviada por ele não pode virar escopo — a rota nunca deriva `organizacao_id`
  // do cliente.
  it('ignora a organização vinda no corpo e usa a do vínculo', async () => {
    fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
    deleteContatoMock.mockResolvedValue(undefined);
    deleteClienteMock.mockResolvedValue(undefined);

    await chamar({ id: 'c1', bling_id: '123', organizacao_id: OUTRA_ORG_ID, organizationId: OUTRA_ORG_ID });

    const [escopo] = deleteClienteMock.mock.calls[0]!;
    expect(escopo).toMatchObject({ organizationId: ORG_ID });
  });
});

describe('POST /api/pedidos/manual — o ator vem do vínculo, não do tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo();
  });

  async function chamar(corpo: unknown, autorizada = true) {
    const { POST } = await import('./pedidos/manual/route');
    return POST(requisicao(URL_VENDA, { metodo: 'POST', autorizada, corpo }));
  }

  it('devolve 401 sem sessão', async () => {
    expect((await chamar({}, false)).status).toBe(401);
  });

  it('devolve 401 quando o provedor recusa o token', async () => {
    fronteira.sessaoInvalida();

    expect((await chamar({})).status).toBe(401);
  });

  it('devolve 503 quando o provedor de identidade está fora do ar', async () => {
    fronteira.provedorDeIdentidadeIndisponivel();

    expect((await chamar({})).status).toBe(503);
  });

  it('devolve 503 quando o depósito de vínculos está indisponível', async () => {
    fronteira.sessaoDe(OWNER_ID).depositoDeVinculosIndisponivel();

    expect((await chamar({})).status).toBe(503);
  });

  it('devolve 403 a quem está autenticado e não tem vínculo', async () => {
    fronteira.sessaoDe(OWNER_ID).semVinculo();

    expect((await chamar({})).status).toBe(403);
  });

  // A venda manual é o caminho da tela, e não exige gestão: um `member` vende.
  // O que importa provar é **qual ator** chega ao serviço. No modelo antigo era
  // o id do tenant, que coincidia com o do usuário só por acidente de forma.
  it('passa ao serviço o `actorId` do usuário e a organização do vínculo', async () => {
    vi.resetModules();
    vi.doMock('@/app/api/pedidos/manual/handler', async () => {
      const real = await vi.importActual<typeof import('@/app/api/pedidos/manual/handler')>(
        '@/app/api/pedidos/manual/handler',
      );
      return { ...real, createManualOrderHandler: criarHandlerVendaManualMock };
    });
    criarHandlerVendaManualMock.mockReturnValue(async () => new Response('{}', { status: 200 }));
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');

    await chamar({});

    expect(criarHandlerVendaManualMock).toHaveBeenCalledTimes(1);
    const deps = criarHandlerVendaManualMock.mock.calls[0]![0] as {
      auth: {
        authenticate: () => Promise<{ actorId: string }>;
        resolveScope: () => Promise<{ scope: { organizationId: string; actorId: string } }>;
      };
    };
    await expect(deps.auth.authenticate()).resolves.toEqual({ actorId: MEMBER_ID });
    const { scope } = await deps.auth.resolveScope();
    expect(scope).toMatchObject({ organizationId: ORG_ID, actorId: MEMBER_ID });
    vi.doUnmock('@/app/api/pedidos/manual/handler');
  });
});
