import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';

/**
 * PRE-001: `POST /contas/pagar` contra um servidor HTTP real e controlado.
 *
 * O que está sob teste é a fronteira entre fato e inferência: o adapter só diz
 * `NaoEnviado` quando nenhuma requisição saiu, e relata `Despachado` — com o
 * que voltou — em todo o resto. "Nada voltou" (prazo, rede, corpo ilegível)
 * tem status 0 e não pode parecer recusa.
 */

const fake = new BlingFake();
/** SAFETY: o adapter é carregado dinamicamente; o tipo vem do próprio módulo. */
let BlingClient: typeof import('./bling').BlingClient;

const ORG = '11111111-1111-4111-8111-111111111111';
const CONTA = {
  contatoId: 7001,
  vencimento: '2026-09-10',
  valor: 1200,
  historico: 'Aluguel',
  dataEmissao: '2026-08-29',
  competencia: '2026-08-29',
  categoriaId: 900,
};

function adapter(token: () => Promise<string> = async () => 'token-de-teste') {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  Object.defineProperty(cliente, 'getAccessToken', { value: token, configurable: true });
  return cliente;
}

async function comPrazo<T>(ms: number, trabalho: () => Promise<T>): Promise<T> {
  const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
  Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: ms, configurable: true });
  try {
    return await trabalho();
  } finally {
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: original, configurable: true });
  }
}

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

describe('criarContaPagar — o que é fato', () => {
  it('201 com o id do OpenAPI oficial ({ id }): despachado e confirmado, sem enviar situacao', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ id: 88123 }) });

    const envio = await adapter().criarContaPagar(CONTA);

    expect(envio).toEqual({ _tag: 'Despachado', resultado: { _tag: 'BlingOk', value: { id: '88123' } } });
    const recebida = fake.recebidas.at(-1)!;
    expect(recebida.method).toBe('POST');
    expect(recebida.url).toBe('/contas/pagar');
    expect(JSON.parse(recebida.body)).toEqual({
      contato: { id: 7001 },
      vencimento: '2026-09-10',
      valor: 1200,
      historico: 'Aluguel',
      dataEmissao: '2026-08-29',
      competencia: '2026-08-29',
      categoria: { id: 900 },
    });
  });

  it('aceita também o envelope { data: { id } } das demais respostas da v3', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: '88124' } }) });

    expect(await adapter().criarContaPagar(CONTA)).toEqual({
      _tag: 'Despachado', resultado: { _tag: 'BlingOk', value: { id: '88124' } },
    });
  });

  it('credencial indisponível: NaoEnviado, e nenhuma requisição chega ao Bling', async () => {
    const envio = await adapter(async () => { throw new Error('cofre indisponível'); }).criarContaPagar(CONTA);

    expect(envio).toEqual({ _tag: 'NaoEnviado', motivo: 'credencial_indisponivel' });
    expect(fake.recebidas).toHaveLength(0);
  });
});

describe('criarContaPagar — o que não prova nada', () => {
  it('2xx sem id: despachado, INVALID_RESPONSE — nunca sucesso', async () => {
    fake.programar({ status: 201, body: JSON.stringify({}) });

    const envio = await adapter().criarContaPagar(CONTA);

    expect(envio._tag).toBe('Despachado');
    if (envio._tag !== 'Despachado' || envio.resultado._tag !== 'BlingFailed') throw new Error('esperava falha despachada');
    expect(envio.resultado.failure).toMatchObject({ type: 'INVALID_RESPONSE', status: 201 });
  });

  it('2xx com corpo ilegível: despachado, sem resposta legível (status 0)', async () => {
    fake.programar({ status: 201, body: '<html>proxy</html>' });

    const envio = await adapter().criarContaPagar(CONTA);

    if (envio._tag !== 'Despachado' || envio.resultado._tag !== 'BlingFailed') throw new Error('esperava falha despachada');
    expect(envio.resultado.failure.status).toBe(0);
  });

  it('5xx: despachado com o status, para a classificação tratar como indeterminado', async () => {
    fake.programar({ status: 500, body: JSON.stringify({ error: { type: 'SERVER_ERROR', message: 'x', description: 'x' } }) });

    const envio = await adapter().criarContaPagar(CONTA);

    if (envio._tag !== 'Despachado' || envio.resultado._tag !== 'BlingFailed') throw new Error('esperava falha despachada');
    expect(envio.resultado.failure).toMatchObject({ type: 'SERVER_ERROR', status: 500 });
  });

  it('prazo esgotado DEPOIS de o POST chegar ao Bling: despachado, status 0 — o POST saiu', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ id: 1 }), atrasoMs: 2_000 });

    const envio = await comPrazo(80, () => adapter().criarContaPagar(CONTA));

    if (envio._tag !== 'Despachado' || envio.resultado._tag !== 'BlingFailed') throw new Error('esperava falha despachada');
    expect(envio.resultado.failure.status).toBe(0);
    expect(fake.recebidas).toHaveLength(1);
  });

  it('falha de rede: despachado com status 0, sem exceção escapando do adapter', async () => {
    const cliente = adapter();
    Object.defineProperty(cliente, 'baseUrl', { value: 'http://127.0.0.1:9', configurable: true });

    const envio = await cliente.criarContaPagar(CONTA);

    if (envio._tag !== 'Despachado' || envio.resultado._tag !== 'BlingFailed') throw new Error('esperava falha despachada');
    expect(envio.resultado.failure.status).toBe(0);
  });

  it('recusa de validação 400: despachado com o tipo do contrato', async () => {
    fake.programar({
      status: 400,
      body: JSON.stringify({ error: { type: 'VALIDATION_ERROR', message: 'Inválido', description: 'contato.id inválido' } }),
    });

    const envio = await adapter().criarContaPagar(CONTA);

    if (envio._tag !== 'Despachado' || envio.resultado._tag !== 'BlingFailed') throw new Error('esperava falha despachada');
    expect(envio.resultado.failure).toMatchObject({ type: 'VALIDATION_ERROR', status: 400 });
  });
});

describe('baixarContaPagar', () => {
  it('falha de rede na quitação vira valor, e não exceção que derrubaria a gravação do título', async () => {
    const cliente = adapter();
    Object.defineProperty(cliente, 'baseUrl', { value: 'http://127.0.0.1:9', configurable: true });

    const baixa = await cliente.baixarContaPagar('88123', { data: '2026-08-29', historico: 'x', portadorId: 55, categoriaId: 900 });

    expect(baixa._tag).toBe('BlingFailed');
  });
});
