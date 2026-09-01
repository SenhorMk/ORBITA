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

/**
 * Recriada a cada caso, e por isso `let`.
 *
 * O cenário guarda tabelas, RPCs e chamadas. Reaproveitá-lo entre casos faria um
 * teste herdar a preparação de outro — e um teste que passa por herança não
 * prova nada sobre o código. O `vi.mock` abaixo lê a variável no momento do
 * acesso, então trocar a instância basta.
 */
let fronteira = new FronteiraDeAutorizacao();
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

/**
 * Tudo o que foi impresso no console, como texto legível.
 *
 * `JSON.stringify(new Error('x'))` devolve `{}` — `message` não é enumerável.
 * Uma asserção construída assim **nunca vê** o vazamento que quer proibir, e
 * passa verde contra o código que imprime o erro cru. Foi o que aconteceu na
 * primeira escrita deste teste, e é por isso que cada argumento é convertido
 * pelo que ele é, e não por serialização genérica.
 */
function textoImpresso(espia: { mock: { calls: unknown[][] } }): string {
  return espia.mock.calls
    .flat()
    .map((argumento: unknown) => {
      if (argumento instanceof Error) return `${argumento.name}: ${argumento.message}`;
      if (typeof argumento === 'string') return argumento;
      try {
        return JSON.stringify(argumento) ?? String(argumento);
      } catch {
        return String(argumento);
      }
    })
    .join(' ');
}

/**
 * Estado neutro, explícito, antes de cada caso.
 *
 * Nenhum teste herda a preparação do anterior: todo dublê volta a resolver
 * `undefined`, e o cenário é novo. Sem isto a suíte fica dependente de ordem —
 * e foi assim que um destes casos passou verde contra o código que vazava, por
 * estar usando o `mockResolvedValue` deixado pelo caso de cima.
 */
async function cenarioLimpo(): Promise<void> {
  vi.clearAllMocks();
  for (const duble of [
    getSituacoesModuloMock,
    getClientesMock,
    createContatoMock,
    deleteContatoMock,
    deleteClienteMock,
    deleteProdutoMock,
    deletePedidoMock,
    getResumoMock,
    createNfeMock,
  ]) {
    duble.mockReset();
    duble.mockResolvedValue(undefined);
  }
  const { produtoRepository } = await import('@/repositories/produtoRepository');
  vi.mocked(produtoRepository.delete).mockReset();
  vi.mocked(produtoRepository.delete).mockResolvedValue(undefined);

  fronteira = new FronteiraDeAutorizacao();
  fronteira.sessaoDe(OWNER_ID).vinculoDe('owner');
}

describe('critério 13 — nenhuma rota migrada devolve diagnóstico interno', () => {
  beforeEach(cenarioLimpo);

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
    const { produtoRepository } = await import('@/repositories/produtoRepository');
    vi.mocked(produtoRepository.delete).mockRejectedValue(falharCom);
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

/**
 * Revisão do head `2d1795a` — a auditoria tinha ficado incompleta.
 *
 * A primeira passagem olhou as respostas de **falha**, e declarou a fronteira
 * segura. Faltavam três lugares por onde o mesmo diagnóstico saía:
 *
 * - o `console.error` cru, que **contorna** `registrarFalhaInterna` e imprime
 *   `message`, `details` e `hint` sem passar pela redação;
 * - `logs`, que volta ao cliente numa resposta **200**, com a causa dentro;
 * - o corpo da NF-e devolvido como `raw`, e registrado no log por inteiro.
 *
 * A lição é a mesma da série: auditar um ramo e concluir sobre a fronteira toda
 * é a família 1 outra vez, agora dentro da própria auditoria.
 */
describe('critério 13 — os ramos que a primeira auditoria não olhou', () => {
  beforeEach(cenarioLimpo);

  it('GET /api/bling/situacoes não imprime o erro cru no console', async () => {
    const console_error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSituacoesModuloMock.mockRejectedValue(falharCom);
    const { GET } = await import('./bling/situacoes/route');

    await GET(requisicao('https://orbita.test/api/bling/situacoes'));

    // O log estruturado sai; o erro cru, não. Um `console.error(…, error)`
    // imprime `message` inteiro, e é por fora da política de redação.
    const impresso = textoImpresso(console_error);
    // Prova de que a espia enxerga: o log estruturado da política aparece aqui.
    expect(impresso).toContain('bling.situacoes.listar');
    expect(impresso).not.toContain('duplicate key');
    expect(impresso).not.toContain('produtos_bling_id_key');
    console_error.mockRestore();
  });

  // Resposta **200**: a exclusão local funcionou, a remota não. O `logs` que
  // acompanha a resposta levava a causa da falha remota dentro.
  it('POST /api/clientes/delete não vaza a causa da falha do Bling no 200', async () => {
    deleteContatoMock.mockRejectedValue(falharCom);
    deleteClienteMock.mockResolvedValue(undefined);
    const { POST } = await import('./clientes/delete/route');

    const resposta = await POST(
      requisicao('https://orbita.test/api/clientes/delete', {
        metodo: 'POST',
        corpo: { id: 'c1', bling_id: '123' },
      }),
    );

    expect(resposta.status).toBe(200);
    await naoVazaDiagnostico(resposta);
  });

  it('POST /api/produtos/delete não vaza a causa da falha do Bling no 200', async () => {
    deleteProdutoMock.mockRejectedValue(falharCom);
    const { POST } = await import('./produtos/delete/route');

    const resposta = await POST(
      requisicao('https://orbita.test/api/produtos/delete', {
        metodo: 'POST',
        corpo: { id: 'p1', bling_id: '123' },
      }),
    );

    expect(resposta.status).toBe(200);
    const corpo = await naoVazaDiagnostico(resposta);
    // O aviso continua: o produto saiu daqui e não de lá.
    expect(corpo.warning).toBe(true);
  });

  // `nfeError` é um `PostgrestError`: `message` carrega texto do Postgres, e
  // num conflito de unicidade carrega o valor da linha junto.
  it('POST /api/nfe não devolve a mensagem do Postgres ao consultar o documento', async () => {
    fronteira
      .rpcResponde('tentar_lock_nfe_organizacao', { data: true, error: null })
      .tabela('documentos_fiscais', {
        data: null,
        error: { message: 'duplicate key value violates unique constraint "produtos_bling_id_key"', code: '23505' },
      });
    const { POST } = await import('./nfe/route');

    const resposta = await POST(
      requisicao('https://orbita.test/api/nfe', {
        metodo: 'POST',
        corpo: { pedidoId: 'ped-1', blingPedidoId: '99' },
      }),
    );

    expect(resposta.status).toBe(500);
    await naoVazaDiagnostico(resposta);
    expect(createNfeMock).not.toHaveBeenCalled();
  });

  // O pior dos cinco: o corpo de uma NF-e — destinatário, itens, valores —
  // saindo duas vezes, na resposta e no log.
  it('POST /api/nfe não devolve nem registra o corpo da nota quando a resposta do Bling é inválida', async () => {
    const console_error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fronteira
      .rpcResponde('tentar_lock_nfe_organizacao', { data: true, error: null })
      .tabela('documentos_fiscais', { data: null, error: null });
    createNfeMock.mockResolvedValue({
      data: {
        // Sem `id` e sem `numero` — é o ramo em questão.
        chave: '35260912345678000199550010000000011000000017',
        destinatario: { nome: 'Fulano de Tal', cpfCnpj: '12345678901' },
        itens: [{ descricao: 'Produto X', valor: 199.9 }],
      },
    });
    const { POST } = await import('./nfe/route');

    const resposta = await POST(
      requisicao('https://orbita.test/api/nfe', {
        metodo: 'POST',
        corpo: { pedidoId: 'ped-1', blingPedidoId: '99' },
      }),
    );

    expect(resposta.status).toBe(502);
    const corpo = JSON.stringify(await resposta.json());
    const registrado = textoImpresso(console_error);

    for (const dado of ['Fulano de Tal', '12345678901', 'Produto X', '199.9', '35260912345678000199']) {
      expect(corpo).not.toContain(dado);
      expect(registrado).not.toContain(dado);
    }
    // O que fica é o **nome** dos campos, que diagnostica sem expor nada.
    expect(registrado).toContain('camposEmData');
    expect(registrado).toContain('destinatario');
    console_error.mockRestore();
  });
});
