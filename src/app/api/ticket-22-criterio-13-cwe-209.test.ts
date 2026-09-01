/**
 * Ticket 22, critério 13 — o que a migração tornou alcançável.
 *
 * O critério pede, **em cada rota migrada**, a conferência de três riscos que o
 * 401 legado mantinha inertes: `catch` que devolve diagnóstico interno ao
 * cliente (CWE-209), sucesso parcial que descarta em silêncio, e leitura
 * privilegiada sem verificação de escopo.
 *
 * A auditoria por handler está no ticket. Os casos abaixo são os achados
 * **reais** dela, do primeiro risco: sete handlers devolviam ao cliente a
 * mensagem do banco, do provedor ou do próprio erro. Nenhum deles é alcançável
 * sem sessão e vínculo — o que é exatamente o ponto. Enquanto tudo respondia
 * 401, esses `catch` nunca executavam.
 *
 * A convenção é a que o ticket 04 estabeleceu e o 20 generalizou:
 * `registrarFalhaInterna` no servidor, frase pública fixa na resposta.
 *
 * **O que não é CWE-209, e continua saindo de propósito:** razão de provedor
 * externo num caminho que exige ação humana. Em `pedidos/manual`, quando a
 * venda falha no ORBITA e o cancelamento no Bling também falha, a mensagem do
 * Bling é o que a pessoa precisa para resolver à mão — e o teste da venda
 * manual já cobra isso. O que saiu de lá foi o erro do banco.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  FronteiraDeAutorizacao,
  requisicao,
  ORG_ID,
  OWNER_ID,
} from './__testkit__/fronteiraDeAutorizacao';

const fronteira = new FronteiraDeAutorizacao();
const falharCom = new Error('duplicate key value violates unique constraint "produtos_bling_id_key"');
const getSituacoesModuloMock = vi.fn();
const getClientesMock = vi.fn();
const createContatoMock = vi.fn();
const deleteContatoMock = vi.fn();
const deleteClienteMock = vi.fn();
const deleteProdutoMock = vi.fn();
const deletePedidoMock = vi.fn();
const getResumoMock = vi.fn();
const createNfeMock = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  get supabaseServer() {
    return fronteira.supabaseServer;
  },
}));
vi.mock('@/services/bling', () => ({
  bling: {
    forVerifiedOrganization: () => ({
      getSituacoesModulo: getSituacoesModuloMock,
      getClientes: getClientesMock,
      createContato: createContatoMock,
      deleteContato: deleteContatoMock,
      deleteProduto: deleteProdutoMock,
      deletePedido: deletePedidoMock,
      createNfe: createNfeMock,
    }),
  },
}));
vi.mock('@/repositories/clienteRepository', () => ({
  clienteRepository: { delete: deleteClienteMock },
}));
vi.mock('@/repositories/produtoRepository', () => ({
  produtoRepository: { delete: vi.fn().mockRejectedValue(falharCom) },
}));
vi.mock('@/repositories/financeiroRepository', () => ({
  financeiroRepository: {
    getResumo: getResumoMock,
    getTitulosFiltro: vi.fn(),
    getCategorias: vi.fn(),
    upsertTitulo: vi.fn(),
  },
}));
vi.mock('@/repositories/pedidoRepository', () => ({
  pedidoRepository: { upsertNfe: vi.fn(), getById: vi.fn(), upsert: vi.fn() },
}));

/**
 * O que uma resposta de falha **nunca** pode conter.
 *
 * Não é uma lista de palavras proibidas: é o texto exato do erro que o dublê
 * lançou. Se ele aparecer, o `catch` está devolvendo diagnóstico ao cliente.
 */
async function naoVazaDiagnostico(resposta: Response): Promise<Record<string, unknown>> {
  const corpo = (await resposta.json()) as Record<string, unknown>;
  const texto = JSON.stringify(corpo);
  expect(texto).not.toContain('duplicate key');
  expect(texto).not.toContain('produtos_bling_id_key');
  expect(texto).not.toContain('unique constraint');
  return corpo;
}

function comSessaoDeGestao() {
  fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
}

describe('critério 13 — nenhuma rota migrada devolve diagnóstico interno', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    comSessaoDeGestao();
  });

  it('GET /api/bling/situacoes', async () => {
    getSituacoesModuloMock.mockRejectedValue(falharCom);
    const { GET } = await import('./bling/situacoes/route');

    const resposta = await GET(requisicao('https://orbita.test/api/bling/situacoes'));

    expect(resposta.status).toBe(500);
    await naoVazaDiagnostico(resposta);
  });

  it('GET /api/financeiro', async () => {
    getResumoMock.mockRejectedValue(falharCom);
    const { GET } = await import('./financeiro/route');

    const resposta = await GET(requisicao('https://orbita.test/api/financeiro'));

    expect(resposta.status).toBe(500);
    await naoVazaDiagnostico(resposta);
  });

  it('GET /api/financeiro/fornecedores', async () => {
    getClientesMock.mockRejectedValue(falharCom);
    const { GET } = await import('./financeiro/fornecedores/route');

    const resposta = await GET(requisicao('https://orbita.test/api/financeiro/fornecedores'));

    expect(resposta.status).toBe(500);
    await naoVazaDiagnostico(resposta);
  });

  // O POST tem `catch` próprio, e a decisão dele é própria — por isso ele
  // aparece separado do GET, como o ticket exige para os dois handlers.
  it('POST /api/financeiro/fornecedores', async () => {
    createContatoMock.mockRejectedValue(falharCom);
    const { POST } = await import('./financeiro/fornecedores/route');

    const resposta = await POST(
      requisicao('https://orbita.test/api/financeiro/fornecedores', {
        metodo: 'POST',
        corpo: { cnpj: '123', nome: 'Fornecedor' },
      }),
    );

    expect(resposta.status).toBe(500);
    await naoVazaDiagnostico(resposta);
  });

  it('POST /api/clientes/delete', async () => {
    deleteContatoMock.mockResolvedValue(undefined);
    deleteClienteMock.mockRejectedValue(falharCom);
    const { POST } = await import('./clientes/delete/route');

    const resposta = await POST(
      requisicao('https://orbita.test/api/clientes/delete', {
        metodo: 'POST',
        corpo: { id: 'c1', bling_id: '123' },
      }),
    );

    expect(resposta.status).toBe(500);
    await naoVazaDiagnostico(resposta);
  });

  // Aqui o vazamento tinha dois caminhos: `details` e o `logs`, que carregava
  // o mesmo texto dentro de uma narrativa de execução.
  it('POST /api/produtos/delete não devolve `details` nem `logs`', async () => {
    deleteProdutoMock.mockResolvedValue(undefined);
    const { POST } = await import('./produtos/delete/route');

    const resposta = await POST(
      requisicao('https://orbita.test/api/produtos/delete', {
        metodo: 'POST',
        corpo: { id: 'p1', bling_id: '123' },
      }),
    );

    expect(resposta.status).toBe(500);
    const corpo = await naoVazaDiagnostico(resposta);
    expect(corpo.details).toBeUndefined();
    expect(corpo.logs).toBeUndefined();
  });

  it('POST /api/nfe', async () => {
    fronteira.rpcResponde('tentar_lock_nfe_organizacao', { data: true, error: null });
    createNfeMock.mockRejectedValue(falharCom);
    const { POST } = await import('./nfe/route');

    const resposta = await POST(
      requisicao('https://orbita.test/api/nfe', {
        metodo: 'POST',
        corpo: { pedidoId: 'ped-1', blingPedidoId: '99' },
      }),
    );

    expect(resposta.status).toBe(500);
    await naoVazaDiagnostico(resposta);
  });

  // O escopo continua sendo o do vínculo em todos os caminhos de falha: a
  // negação não muda de organização por causa de um erro.
  it('a organização usada no caminho de falha continua sendo a do vínculo', async () => {
    fronteira.rpcResponde('tentar_lock_nfe_organizacao', { data: true, error: null }).limparChamadas();
    createNfeMock.mockRejectedValue(falharCom);
    const { POST } = await import('./nfe/route');

    await POST(
      requisicao('https://orbita.test/api/nfe', {
        metodo: 'POST',
        corpo: { pedidoId: 'ped-1', blingPedidoId: '99' },
      }),
    );

    expect(fronteira.chamadasDeRpc[0]).toMatchObject({
      argumentos: { p_organizacao_id: ORG_ID },
    });
  });
});
