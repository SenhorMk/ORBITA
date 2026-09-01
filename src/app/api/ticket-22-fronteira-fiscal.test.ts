/**
 * Ticket 22, critério 14 — regressão de fronteira do domínio **fiscal**.
 *
 * Um handler, nominalmente: `POST /api/nfe`. Faturar é a ação de maior
 * consequência entre as que restaram sem regressão própria — emite documento
 * fiscal no ERP —, e até aqui a autorização dela não era atravessada por
 * nenhum teste.
 *
 * A rota importada de verdade, a cadeia real de
 * `resolveVerifiedOrganizationScope`, e o `organization:manage` cobrado sobre o
 * papel do vínculo. Nada fabricado.
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
const createNfeMock = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  get supabaseServer() {
    return fronteira.supabaseServer;
  },
}));
vi.mock('@/services/bling', () => ({
  bling: { forVerifiedOrganization: () => ({ createNfe: createNfeMock }) },
}));
vi.mock('@/repositories/pedidoRepository', () => ({
  pedidoRepository: { upsertNfe: vi.fn(), getById: vi.fn(), upsert: vi.fn() },
}));

const URL_NFE = 'https://orbita.test/api/nfe';
const CORPO = { pedidoId: 'ped-1', blingPedidoId: '99' };

describe('POST /api/nfe — faturar exige gestão na organização', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fronteira.semVinculo().limparChamadas();
  });

  async function chamar(corpo: unknown = CORPO, autorizada = true) {
    const { POST } = await import('./nfe/route');
    return POST(requisicao(URL_NFE, { metodo: 'POST', autorizada, corpo }));
  }

  it('devolve 401 sem sessão, e não emite nada', async () => {
    const resposta = await chamar(CORPO, false);

    expect(resposta.status).toBe(401);
    expect(createNfeMock).not.toHaveBeenCalled();
    expect(fronteira.chamadasDeRpc).toHaveLength(0);
  });

  it('devolve 401 quando o provedor recusa o token', async () => {
    fronteira.sessaoInvalida();

    expect((await chamar()).status).toBe(401);
    expect(createNfeMock).not.toHaveBeenCalled();
  });

  it('devolve 503, e não 401, quando o provedor de identidade está fora do ar', async () => {
    fronteira.provedorDeIdentidadeIndisponivel();

    expect((await chamar()).status).toBe(503);
    expect(createNfeMock).not.toHaveBeenCalled();
  });

  it('devolve 503, e não 403, quando o depósito de vínculos está indisponível', async () => {
    fronteira.sessaoDe(OWNER_ID).depositoDeVinculosIndisponivel();

    expect((await chamar()).status).toBe(503);
    expect(createNfeMock).not.toHaveBeenCalled();
  });

  it('devolve 403 a quem está autenticado e não tem vínculo', async () => {
    fronteira.sessaoDe(OWNER_ID).semVinculo();

    expect((await chamar()).status).toBe(403);
    expect(createNfeMock).not.toHaveBeenCalled();
  });

  it('nega o membro com 403: ler pedidos não autoriza faturá-los', async () => {
    fronteira.sessaoDe(MEMBER_ID).vinculoDe('member');

    expect((await chamar()).status).toBe(403);
    expect(createNfeMock).not.toHaveBeenCalled();
    expect(fronteira.chamadasDeRpc).toHaveLength(0);
  });

  it('deixa o admin passar da autorização, o que o papel legado impedia', async () => {
    fronteira.sessaoDe(ADMIN_ID).vinculoDe('admin');

    // Sem `pedidoId`/`blingPedidoId` a rota responde 400 — e chegar ao 400 já
    // prova que a autorização deixou passar, sem emitir documento nenhum.
    expect((await chamar({})).status).toBe(400);
    expect(createNfeMock).not.toHaveBeenCalled();
  });

  // Caminho positivo, e isolamento do recurso ao mesmo tempo: o lock de
  // faturamento é pedido para a organização do **vínculo**, com o pedido vindo
  // do corpo. Uma organização enviada pelo cliente não entra nessa conta.
  it('pede o lock com a organização do vínculo, ignorando a que vier no corpo', async () => {
    fronteira.sessaoDe(OWNER_ID).vinculoDe('owner').rpcResponde('tentar_lock_nfe_organizacao', {
      data: false,
      error: null,
    });

    const resposta = await chamar({ ...CORPO, organizacao_id: OUTRA_ORG_ID });

    // O lock foi recusado de propósito: o 429 prova que a rota chegou até ele,
    // e a asserção seguinte prova com que organização ela chegou.
    expect(resposta.status).toBe(429);
    expect(fronteira.chamadasDeRpc).toEqual([
      {
        nome: 'tentar_lock_nfe_organizacao',
        argumentos: { p_organizacao_id: ORG_ID, p_pedido_id: 'ped-1' },
      },
    ]);
  });
});
