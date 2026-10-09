import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';

/**
 * PRE-002: o contrato HTTP das leituras de reconciliação e da baixa, contra um
 * servidor real e controlado. Só filtros que o OpenAPI declara; listagem
 * incompleta, 429, 5xx e corpo ilegível nunca viram "não existe".
 */

const fake = new BlingFake();
/** SAFETY: o adapter é carregado dinamicamente; o tipo vem do próprio módulo. */
let BlingClient: typeof import('./bling').BlingClient;

const ORG = '11111111-1111-4111-8111-111111111111';
const FILTRO = { dataEmissao: '2026-10-09', dataVencimento: '2026-10-20', contatoId: 7001 };

function adapter() {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  Object.defineProperty(cliente, 'getAccessToken', { value: async () => 'token-de-teste', configurable: true });
  return cliente;
}

const item = (id: number) => ({ id, situacao: 1, valor: 1200, vencimento: '2026-10-20', contato: { id: 7001 } });
const pagina = (n: number, desde = 1) => JSON.stringify({ data: Array.from({ length: n }, (_, i) => item(desde + i)) });

beforeAll(async () => {
  const baseUrl = await fake.iniciar();
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

describe('listarContasPagarParaReconciliacao', () => {
  it('envia só os filtros oficiais — emissão, vencimento e contato — e lê até a página não cheia', async () => {
    fake.programar({ status: 200, body: pagina(100) }, { status: 200, body: pagina(3, 101) });

    const listagem = await adapter().listarContasPagarParaReconciliacao(FILTRO);

    expect(listagem._tag).toBe('Listada');
    if (listagem._tag === 'Listada') expect(listagem.contas).toHaveLength(103);
    const url = new URL(fake.recebidas[0]!.url, 'http://x');
    expect(url.pathname).toBe('/contas/pagar');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      pagina: '1', limite: '100', dataEmissaoInicial: '2026-10-09', dataEmissaoFinal: '2026-10-09',
      dataVencimentoInicial: '2026-10-20', dataVencimentoFinal: '2026-10-20', idContato: '7001',
    });
    expect(new URL(fake.recebidas[1]!.url, 'http://x').searchParams.get('pagina')).toBe('2');
  });

  it('sem contato conhecido, não inventa o filtro', async () => {
    fake.programar({ status: 200, body: pagina(0) });

    await adapter().listarContasPagarParaReconciliacao({ ...FILTRO, contatoId: null });

    expect(new URL(fake.recebidas[0]!.url, 'http://x').searchParams.has('idContato')).toBe(false);
  });

  it('teto de páginas atingido: listagem incompleta, nunca "não existe"', async () => {
    fake.programar(...Array.from({ length: 5 }, () => ({ status: 200, body: pagina(100) })));

    expect(await adapter().listarContasPagarParaReconciliacao(FILTRO)).toEqual({ _tag: 'ListagemIncompleta' });
  });

  it.each([
    [429, { _tag: 'RemotoLimitado' }],
    [500, { _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' }],
  ])('HTTP %i: falha classificada, sem lista', async (status, esperado) => {
    fake.programar(...Array.from({ length: 4 }, () => ({ status, body: '{}' })));

    expect(await adapter().listarContasPagarParaReconciliacao(FILTRO)).toEqual(esperado);
  });

  it('corpo ilegível: indeterminado', async () => {
    fake.programar({ status: 200, body: '<html>proxy</html>' });

    expect(await adapter().listarContasPagarParaReconciliacao(FILTRO)).toEqual({ _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' });
  });
});

describe('lerContaPagarParaReconciliacao', () => {
  it('lê referência, emissão, saldo e borderôs do detalhe', async () => {
    fake.programar({
      status: 200,
      body: JSON.stringify({ data: { ...item(88123), situacao: 2, dataEmissao: '2026-10-09', numeroDocumento: 'ORB-0123456789ABCDEF', saldo: 0, borderos: [555] } }),
    });

    const leitura = await adapter().lerContaPagarParaReconciliacao('88123');

    expect(leitura).toEqual({
      _tag: 'RemotoPresente',
      valor: {
        id: '88123', situacao: 2, valor: 1200, vencimento: '2026-10-20', contatoId: 7001, dataEmissao: '2026-10-09',
        numeroDocumento: 'ORB-0123456789ABCDEF', saldo: 0, historico: null, categoriaId: null, borderos: ['555'],
      },
    });
    expect(fake.recebidas.at(-1)!.url).toBe('/contas/pagar/88123');
  });

  it('404: ausente pela leitura', async () => {
    fake.programar({ status: 404, body: '{}' });

    expect(await adapter().lerContaPagarParaReconciliacao('1')).toEqual({ _tag: 'RemotoAusente' });
  });

  it('corpo sem os campos do contrato: indeterminado', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 1 } }) });

    expect(await adapter().lerContaPagarParaReconciliacao('1')).toEqual({ _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' });
  });
});

describe('criação e baixa', () => {
  it('a referência opaca vai em numeroDocumento', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ id: 1 }) });

    await adapter().criarContaPagar({
      contatoId: 7001, vencimento: '2026-10-20', valor: 1, historico: 'x', dataEmissao: '2026-10-09', competencia: '2026-10-09',
      numeroDocumento: 'ORB-0123456789ABCDEF',
    });

    expect(JSON.parse(fake.recebidas.at(-1)!.body)).toMatchObject({ numeroDocumento: 'ORB-0123456789ABCDEF' });
  });

  it('baixa 200 com o borderô: confirmada, com o id do borderô', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { bordero: { id: 555 } } }) });

    expect(await adapter().baixarContaPagar('88123', { data: '2026-10-09', historico: 'x', portadorId: 1, categoriaId: 2 }))
      .toEqual({ _tag: 'Despachado', resultado: { _tag: 'BlingOk', value: { borderoId: '555' } } });
  });

  it('baixa 200 sem o borderô: não prova a quitação', async () => {
    fake.programar({ status: 200, body: JSON.stringify({}) });

    const envio = await adapter().baixarContaPagar('88123', { data: '2026-10-09', historico: 'x', portadorId: 1, categoriaId: 2 });

    expect(envio).toMatchObject({ _tag: 'Despachado', resultado: { _tag: 'BlingFailed', failure: { type: 'INVALID_RESPONSE' } } });
  });

  it('baixa sem credencial: nenhuma requisição sai', async () => {
    const cliente = adapter();
    Object.defineProperty(cliente, 'getAccessToken', { value: async () => { throw new Error('cofre'); }, configurable: true });

    expect(await cliente.baixarContaPagar('88123', { data: '2026-10-09', historico: 'x', portadorId: 1, categoriaId: 2 }))
      .toEqual({ _tag: 'NaoEnviado', motivo: 'credencial_indisponivel' });
    expect(fake.recebidas).toHaveLength(0);
  });
});
