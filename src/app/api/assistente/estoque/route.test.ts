import { beforeEach, describe, expect, it, vi } from 'vitest';

const porta = vi.hoisted(() => ({ sessao: vi.fn(), interpretar: vi.fn(), ler: vi.fn(), capacidade: vi.fn() }));
vi.mock('@/lib/requestOrganizationContext', () => ({ resolveVerifiedOrganizationScope: porta.sessao }));
vi.mock('@/lib/verifiedOrganizationScope', () => ({ escopoTemCapacidade: porta.capacidade }));
vi.mock('@/lib/supabaseServer', () => ({ supabaseServer: {} }));
vi.mock('@/repositories/leituraDeEstoqueAdministrativo', () => ({ lerSaldoDoProduto: porta.ler }));
vi.mock('@/services/assistenteAdministrativo/interpretarEstoque', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/assistenteAdministrativo/interpretarEstoque')>(),
  interpretarPerguntaDeEstoque: porta.interpretar,
}));

import { POST } from './route';

const escopo = { actorId: 'sessao', organizationId: 'org-verificada', role: 'member' };
const produto = { nome: 'Amostra', codigo: 'DEMO', estoque: 7, estoque_reservado: 3 };
const pedir = (body: object) => POST(new Request('http://localhost/api/assistente/estoque', {
  method: 'POST', body: JSON.stringify(body),
}));

describe('rota administrativa de estoque', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    porta.sessao.mockResolvedValue({ _tag: 'RequestScopeResolved', scope: escopo });
    porta.capacidade.mockReturnValue(true);
    porta.interpretar.mockResolvedValue({ acao: 'consultar', produto: 'DEMO' });
    porta.ler.mockResolvedValue([produto]);
  });

  it('recusa sessão ausente e capacidade ausente antes de chamar o modelo', async () => {
    porta.sessao.mockResolvedValueOnce({ _tag: 'RequestScopeDenied', response: new Response(null, { status: 401 }) });
    expect((await pedir({ pergunta: 'Saldo DEMO' })).status).toBe(401);
    porta.capacidade.mockReturnValue(false);
    expect((await pedir({ pergunta: 'Saldo DEMO' })).status).toBe(403);
    expect(porta.interpretar).not.toHaveBeenCalled();
    expect(porta.ler).not.toHaveBeenCalled();
  });

  it('rejeita autoridade no corpo e usa somente o escopo da sessão', async () => {
    expect((await pedir({ pergunta: 'Saldo DEMO', organizationId: 'outra' })).status).toBe(400);
    expect(porta.interpretar).not.toHaveBeenCalled();
    const response = await pedir({ pergunta: 'Quanto temos no SKU DEMO?' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ estado: 'ok', produto: { disponivel: 4, fisico: 7, reservado: 3 } });
    expect(porta.ler).toHaveBeenCalledWith(expect.anything(), escopo, 'DEMO');
  });

  it('recusa pedido de baixa e referência inventada pelo modelo', async () => {
    porta.interpretar.mockResolvedValueOnce({ acao: 'alterar', produto: 'DEMO' });
    expect(await (await pedir({ pergunta: 'Dê baixa no DEMO' })).json()).toMatchObject({ estado: 'escrita_indisponivel' });
    expect(await (await pedir({ pergunta: 'Quanto temos de amostra?' })).json()).toMatchObject({ estado: 'esclarecer' });
    expect(porta.ler).not.toHaveBeenCalled();
  });

  it('distingue ambiguidade, saldo ausente e falha do banco', async () => {
    porta.ler.mockResolvedValueOnce([produto, { ...produto, codigo: 'DEMO-2' }]);
    expect(await (await pedir({ pergunta: 'Saldo DEMO' })).json()).toMatchObject({ estado: 'ambiguo' });
    porta.ler.mockResolvedValueOnce([{ ...produto, estoque_reservado: null }]);
    expect(await (await pedir({ pergunta: 'Saldo DEMO' })).json()).toMatchObject({ estado: 'saldo_desconhecido' });
    porta.ler.mockRejectedValueOnce(new Error('falha'));
    expect((await pedir({ pergunta: 'Saldo DEMO' })).status).toBe(503);
  });
});
