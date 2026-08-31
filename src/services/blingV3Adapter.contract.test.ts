import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';

/**
 * Contract tests do adapter Bling v3 contra um **servidor HTTP real** e
 * controlado — nunca mock de módulo.
 *
 * O ticket 10b exige isso porque um mock de módulo prova apenas que o código
 * chama o que o teste mandou chamar. O que precisa ser provado aqui é o
 * comportamento na fronteira HTTP de verdade: o caminho e o método montados, o
 * corpo serializado, e a reação a 429, 401, 5xx, corpo inválido e paginação.
 *
 * O adapter é carregado dinamicamente **depois** de configurar as variáveis de
 * ambiente, para que `baseUrl` aponte para o servidor fake em vez da API real.
 */

const fake = new BlingFake();
let baseUrl = '';
/** SAFETY: o adapter é carregado dinamicamente; o tipo vem do próprio módulo. */
let BlingClient: typeof import('./bling').BlingClient;

const ORG = '11111111-1111-4111-8111-111111111111';

/** Cria um adapter apontado para o fake, com o token já resolvido. */
function adapter() {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  // O token vem do cofre em produção; aqui o teste injeta um resolvido, porque
  // o que está sob teste é a fronteira HTTP dos recursos, não o OAuth.
  Object.defineProperty(cliente, 'getAccessToken', {
    value: async () => 'token-de-teste',
    configurable: true,
  });
  return cliente;
}

beforeAll(async () => {
  baseUrl = await fake.iniciar();
  vi.stubEnv('BLING_API_BASE_URL', baseUrl);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://contract-test-000000.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'contract-test-service-role-key-000000');
  ({ BlingClient } = await import('./bling'));
});

afterEach(() => {
  fake.limpar();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fake.parar();
});

describe('caminho e corpo enviados ao Bling', () => {
  it('cria o pedido de venda em POST /pedidos/vendas com o payload serializado', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 918273 } }) });

    const resultado = await adapter().criarPedidoVenda({
      contato: { id: 4321 },
      data: '2026-08-29',
      dataPrevista: '2026-08-29',
      dataSaida: '2026-08-29',
      itens: [{ descricao: 'Camiseta', quantidade: 2, valor: 49.9, valorLista: 49.9, produto: { id: 77 } }],
      parcelas: [{ dataVencimento: '2026-08-29', valor: 99.8, formaPagamento: { id: 12 } }],
    });

    expect(resultado).toEqual({ _tag: 'BlingOk', value: { id: '918273', alertas: [] } });
    const requisicao = fake.recebidas.at(-1)!;
    expect(requisicao.method).toBe('POST');
    expect(requisicao.url).toBe('/pedidos/vendas');
    expect(JSON.parse(requisicao.body)).toMatchObject({ contato: { id: 4321 }, dataPrevista: '2026-08-29' });
    expect(requisicao.authorization).toBe('Bearer token-de-teste');
  });

  it('busca produto por SKU com o filtro documentado codigos[]', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: [{ id: 5, codigo: 'CAM-01' }] }) });

    const encontrado = await adapter().buscarProdutoPorCodigo('CAM-01');

    expect(encontrado?.id).toBe(5);
    expect(fake.recebidas.at(-1)!.url).toContain('codigos%5B%5D=CAM-01');
    expect(fake.recebidas.at(-1)!.url).not.toContain('codigo=CAM-01');
  });

  it('devolve null quando o código do resultado não bate — guarda contra PUT destrutivo', async () => {
    // O provedor ignorando um filtro devolve a listagem inteira; confiar nela
    // sobrescrevia um produto não relacionado.
    fake.programar({ status: 200, body: JSON.stringify({ data: [{ id: 999, codigo: 'OUTRO-SKU' }] }) });

    expect(await adapter().buscarProdutoPorCodigo('CAM-01')).toBeNull();
  });

  it('quita a conta a pagar no endpoint próprio, com portador e categoria', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: {} }) });

    const resultado = await adapter().baixarContaPagar('88123', {
      data: '2026-08-29', historico: 'Aluguel', portadorId: 55, categoriaId: 900,
    });

    expect(resultado._tag).toBe('BlingOk');
    const requisicao = fake.recebidas.at(-1)!;
    expect(requisicao.url).toBe('/contas/pagar/88123/baixar');
    expect(JSON.parse(requisicao.body)).toMatchObject({ portador: { id: 55 }, categoria: { id: 900 } });
  });

  it('lê o portador de /contas-contabeis e prefere o tipo caixa', async () => {
    fake.programar({
      status: 200,
      body: JSON.stringify({ data: [{ id: 10, tipo: 'banco' }, { id: 20, tipo: 'caixa' }] }),
    });

    const resultado = await adapter().obterContaFinanceiraPadraoId();

    expect(resultado).toEqual({ _tag: 'BlingOk', value: 20 });
    expect(fake.recebidas.at(-1)!.url).toBe('/contas-contabeis');
  });
});

describe('erro do provedor', () => {
  it('traduz o envelope de erro da v3 em falha tipada e legível', async () => {
    fake.programar({
      status: 400,
      body: JSON.stringify({
        error: {
          type: 'VALIDATION_ERROR',
          description: 'Não foi possível salvar o pedido de venda',
          fields: [{ code: 10, msg: 'Campo obrigatório', element: 'parcelas' }],
        },
      }),
    });

    const resultado = await adapter().criarPedidoVenda({
      contato: { id: 1 }, data: '2026-08-29', dataPrevista: '2026-08-29', dataSaida: '2026-08-29',
      itens: [{ descricao: 'X', quantidade: 1, valor: 1, valorLista: 1, produto: { id: 2 } }],
      parcelas: [{ dataVencimento: '2026-08-29', valor: 1, formaPagamento: { id: 3 } }],
    });

    expect(resultado._tag).toBe('BlingFailed');
    if (resultado._tag === 'BlingFailed') {
      expect(resultado.failure.type).toBe('VALIDATION_ERROR');
      expect(resultado.failure.message).toContain('parcelas: Campo obrigatório');
      expect(resultado.failure.message).not.toContain('{');
    }
  });

  it('recusa uma resposta 201 sem id em vez de inventar um identificador', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: {} }) });

    const resultado = await adapter().criarProduto({
      nome: 'X', preco: 1, tipo: 'P', situacao: 'A', formato: 'S', unidade: 'UN',
    });

    expect(resultado._tag).toBe('BlingFailed');
    if (resultado._tag === 'BlingFailed') {
      expect(resultado.failure.type).toBe('INVALID_RESPONSE');
    }
  });

  it('uma leitura que falha nao vira lista vazia', async () => {
    // Este teste ja afirmou o contrario, e a afirmacao estava errada.
    // Devolver `[]` numa falha tornava "o provedor recusou" indistinguivel de
    // "nao ha nada": a sincronizacao concluia com zero itens, o checkpoint
    // avancava, e a partir dali o Bling era consultado por "alterados desde o
    // momento da falha" — respondendo zero, corretamente, para sempre.
    fake.programar({ status: 500, body: '{"error":{"type":"SERVER_ERROR"}}' });

    await expect(adapter().getProdutos(1, 10)).rejects.toThrow(/produtos.*500/i);
  });

  it('uma falha de leitura de contatos tambem estoura, em vez de fingir zero', async () => {
    fake.programar({ status: 403, body: '{"error":{"type":"FORBIDDEN"}}' });

    await expect(adapter().getClientes(1, 10)).rejects.toThrow(/contatos.*403/i);
  });

it.each([
    ['envelope de erro com HTTP 200', '{"error":{"type":"SERVER_ERROR"}}'],
    ['data que não é lista', '{"data":{}}'],
    ['corpo sem data', '{"pagina":1}'],
    ['nulo', 'null'],
  ])('conta a pagar: %s não vira lista vazia', async (_nome, body) => {
    // A porta que ficou aberta no ticket 05. O 401/403/500 passou a estourar,
    // mas um HTTP **200** com envelope inválido ainda caía em `[]` — e `[]` é
    // exatamente o que o laço lê como "acabaram os dados": checkpoint avança,
    // rota responde sucesso, zero contas.
    fake.programar({ status: 200, body });

    await expect(adapter().getContasPagar(1, 100)).rejects.toThrow(/contas a pagar/i);
  });

  it('conta a receber: envelope inválido com HTTP 200 também estoura', async () => {
    fake.programar({ status: 200, body: '{"data":"nao-e-lista"}' });

    await expect(adapter().getContasReceber(1, 100)).rejects.toThrow(/contas a receber/i);
  });

  it('lista vazia legítima continua sendo lista vazia', async () => {
    // O outro lado da guarda: apertar demais transformaria "não há contas" em
    // erro, e a sincronização nunca concluiria.
    fake.programar({ status: 200, body: '{"data":[]}' });

    await expect(adapter().getContasPagar(1, 100)).resolves.toEqual([]);
  });

    it('sobrevive a corpo que não é JSON', async () => {
    fake.programar({ status: 502, body: '<html>Bad Gateway</html>' });

    const resultado = await adapter().obterContaFinanceiraPadraoId();

    expect(resultado._tag).toBe('BlingFailed');
    if (resultado._tag === 'BlingFailed') {
      expect(resultado.failure.type).toBe('HTTP_502');
    }
  });
});

describe('rate limit e retry', () => {
  it('repete a requisição depois de um 429 e devolve o sucesso seguinte', async () => {
    fake.programar(
      { status: 429, body: '{"error":{"type":"TOO_MANY_REQUESTS"}}', headers: { 'Retry-After': '0' } },
      { status: 200, body: JSON.stringify({ data: [{ id: 1, codigo: 'A' }] }) },
    );

    const produtos = await adapter().getProdutos(1, 10);

    expect(produtos).toHaveLength(1);
    // Duas idas ao servidor: a recusada e a repetida.
    expect(fake.recebidas).toHaveLength(2);
  }, 20_000);
});

describe('paginação', () => {
  it('propaga pagina e limite na query, sem inventar valores', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: [] }) });

    await adapter().getPedidos(3, 25, '2026-01-01');

    const url = fake.recebidas.at(-1)!.url;
    expect(url).toContain('pagina=3');
    expect(url).toContain('limite=25');
    expect(url).toContain('dataInicial=2026-01-01');
  });

  it('cada página é uma requisição distinta ao provedor', async () => {
    fake.definirPadrao({ status: 200, body: JSON.stringify({ data: [{ id: 1 }] }) });

    await adapter().getPedidos(1, 100);
    await adapter().getPedidos(2, 100);

    expect(fake.recebidas.map((r) => new URL(r.url, 'http://x').searchParams.get('pagina'))).toEqual(['1', '2']);
    fake.definirPadrao({ status: 200, body: JSON.stringify({ data: [] }) });
  });
});

describe('concorrência', () => {
  it('serializa requisições simultâneas sem perder nenhuma', async () => {
    fake.definirPadrao({ status: 200, body: JSON.stringify({ data: [] }) });
    const cliente = adapter();

    await Promise.all([
      cliente.getProdutos(1, 10),
      cliente.getProdutos(2, 10),
      cliente.getProdutos(3, 10),
    ]);

    expect(fake.recebidas).toHaveLength(3);
    const paginas = fake.recebidas
      .map((r) => new URL(r.url, 'http://x').searchParams.get('pagina'))
      .sort();
    expect(paginas).toEqual(['1', '2', '3']);
  }, 20_000);
});
