import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';

/**
 * Leitura e exclusão por id — contato e conta a pagar — contra um servidor
 * HTTP real e controlado. O que se prova é a classificação: cada resposta vira
 * o que ela prova sobre o recurso remoto, e nenhuma vira sucesso sem prova.
 *
 * Nenhuma requisição sai para o Bling de verdade: `BLING_API_BASE_URL` aponta
 * para o fake.
 */

const fake = new BlingFake();
/** SAFETY: o adapter é carregado dinamicamente; o tipo vem do próprio módulo. */
let BlingClient: typeof import('./bling').BlingClient;

const ORG = '11111111-1111-4111-8111-111111111111';

function adapter() {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  Object.defineProperty(cliente, 'getAccessToken', { value: async () => 'token-de-teste', configurable: true });
  return cliente;
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

describe('contato por id', () => {
  it('DELETE /contatos/{id} com 204 é exclusão aceita', async () => {
    fake.programar({ status: 204, body: '' });

    expect(await adapter().excluirContato('5550001')).toEqual({ _tag: 'ExclusaoAceita' });
    expect(fake.recebidas.map((r) => `${r.method} ${r.url}`)).toEqual(['DELETE /contatos/5550001']);
  });

  it('GET /contatos/{id} com 404 é ausência, não falha de transporte', async () => {
    fake.programar({ status: 404, body: JSON.stringify({ error: { type: 'RESOURCE_NOT_FOUND' } }) });
    expect(await adapter().consultarContato('5550001')).toEqual({ _tag: 'RemotoAusente' });
  });

  it('GET /contatos/{id} com 200 e corpo do contrato é presença', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 5550001, nome: 'Contato' } }) });
    expect(await adapter().consultarContato('5550001')).toEqual({ _tag: 'RemotoPresente', valor: { id: '5550001', situacao: null } });
  });

  it('GET /contatos/{id} devolve a situação, para a reativação distinguir a lixeira (E) do ativo (PRE-005)', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 5550001, nome: 'Contato', situacao: 'E' } }) });
    expect(await adapter().consultarContato('5550001')).toEqual({ _tag: 'RemotoPresente', valor: { id: '5550001', situacao: 'E' } });
  });

  it('400 no DELETE é recusa definitiva, sem o corpo do provedor no resultado', async () => {
    fake.programar({ status: 400, body: JSON.stringify({ error: { description: 'segredo do provedor' } }) });
    const resultado = await adapter().excluirContato('5550001');
    expect(resultado).toEqual({ _tag: 'RemotoRecusou', status: 400 });
    expect(JSON.stringify(resultado)).not.toContain('segredo');
  });

  it('5xx no DELETE é indeterminado — pode ter tido efeito', async () => {
    fake.programar({ status: 503, body: 'indisponível' });
    expect(await adapter().excluirContato('5550001')).toEqual({ _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' });
  });

  it('429 que persiste depois do retry do adapter é limite: não processado', async () => {
    fake.programar(
      { status: 429, body: '', headers: { 'Retry-After': '0' } },
      { status: 429, body: '', headers: { 'Retry-After': '0' } },
    );
    expect(await adapter().excluirContato('5550001')).toEqual({ _tag: 'RemotoLimitado' });
  });

  it('prazo esgotado é indeterminado e solta a conexão', async () => {
    const original = BlingClient.TEMPO_LIMITE_CORRECAO_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_CORRECAO_MS', { value: 80, configurable: true });
    try {
      fake.programar({ status: 204, body: '', atrasoMs: 1_000 });
      expect(await adapter().excluirContato('5550001')).toEqual({ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' });
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_CORRECAO_MS', { value: original, configurable: true });
    }
  });

  it('falha de rede é indeterminada', async () => {
    const cliente = adapter();
    // Porta local fechada: a conexão é recusada antes de qualquer resposta.
    Object.defineProperty(cliente, 'baseUrl', { value: 'http://127.0.0.1:9', configurable: true });
    expect(await cliente.excluirContato('5550001')).toEqual({ _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' });
  });
});

describe('conta a pagar por id', () => {
  it('GET /contas/pagar/{id} devolve a situação oficial (1..7)', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 8800001, situacao: 3, valor: 10 } }) });

    expect(await adapter().consultarContaPagar('8800001')).toEqual({
      _tag: 'RemotoPresente',
      valor: { id: '8800001', situacao: 3 },
    });
    expect(fake.recebidas[0]).toMatchObject({ method: 'GET', url: '/contas/pagar/8800001' });
  });

  it('situação fora do contrato é resposta inválida — nem presente nem ausente', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 8800001, situacao: 9 } }) });
    expect(await adapter().consultarContaPagar('8800001')).toEqual({ _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' });
  });

  it('DELETE /contas/pagar/{id} com 204 é exclusão aceita', async () => {
    fake.programar({ status: 204, body: '' });
    expect(await adapter().excluirContaPagar('8800001')).toEqual({ _tag: 'ExclusaoAceita' });
    expect(fake.recebidas[0]).toMatchObject({ method: 'DELETE', url: '/contas/pagar/8800001' });
  });

  it('DELETE com 404 é devolvido como ausente (a confirmação por leitura é de quem chama)', async () => {
    fake.programar({ status: 404, body: '' });
    expect(await adapter().excluirContaPagar('8800001')).toEqual({ _tag: 'RemotoAusente' });
  });

  it('nenhum caminho de borderô é chamado', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 8800001, situacao: 2 } }) });
    await adapter().consultarContaPagar('8800001');
    expect(fake.recebidas.some((r) => r.url.includes('/borderos'))).toBe(false);
  });
});
