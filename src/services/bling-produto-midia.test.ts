import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';

/**
 * Produto no Bling: atualização comum, exclusão confirmada e imagens — contra
 * um servidor HTTP real e controlado. Nenhuma requisição sai para o Bling de
 * verdade: `BLING_API_BASE_URL` aponta para o fake.
 *
 * Os comportamentos remotos que estas operações assumem foram provados na conta
 * Bling em 2026-10-02 (`docs/operations/foto-produto-sync-bling.md`); aqui se
 * prova o que o ORBITA envia e como classifica cada resposta.
 */

const fake = new BlingFake();
/** SAFETY: o adapter é carregado dinamicamente; o tipo vem do próprio módulo. */
let BlingClient: typeof import('./bling').BlingClient;

const ORG = '11111111-1111-4111-8111-111111111111';
const URL_ASSINADA = 'https://proj.supabase.co/storage/v1/object/sign/produto-imagens/o/p/x.png?token=capacidade-temporaria';

function adapter() {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  Object.defineProperty(cliente, 'getAccessToken', { value: async () => 'token-de-teste', configurable: true });
  return cliente;
}

const corpo = (i = 0) => JSON.parse(fake.recebidas[i]!.body || 'null');
const ENTRADA = { nome: 'Kuripe', preco: 10, tipo: 'P', situacao: 'A', formato: 'S', unidade: 'UN', codigo: 'KUR-1', categoria: { id: 900 } };

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

describe('atualização comum de produto — PATCH, nunca PUT', () => {
  it('usa PATCH /produtos/{id} com o corpo validado e SEM midia (PUT sem midia apaga as imagens no Bling)', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 777 } }) });
    expect(await adapter().atualizarProduto('777', ENTRADA)).toEqual({ _tag: 'BlingOk', value: undefined });

    expect(fake.recebidas.map((r) => `${r.method} ${r.url}`)).toEqual(['PATCH /produtos/777']);
    expect(corpo()).toEqual({
      nome: 'Kuripe', preco: 10, tipo: 'P', situacao: 'A', formato: 'S', unidade: 'UN',
      codigo: 'KUR-1', categoria: { id: 900 }, variacoes: [],
    });
    expect(corpo()).not.toHaveProperty('midia');
  });

  it('nenhum PUT de produto no adapter', async () => {
    const { readFileSync } = await import('node:fs');
    const fonte = readFileSync(new URL('./bling.ts', import.meta.url), 'utf8');
    const trecho = fonte.slice(fonte.indexOf('async atualizarProduto'), fonte.indexOf('async definirSaldoProduto'));
    expect(trecho).toContain("method: 'PATCH'");
    expect(trecho).not.toContain("method: 'PUT'");
  });
});

describe('exclusão de produto', () => {
  it('situação E: PATCH /produtos/{id}/situacoes com { situacao: "E" }', async () => {
    fake.programar({ status: 204, body: '' });
    expect(await adapter().marcarProdutoExcluido('777')).toEqual({ _tag: 'EscritaAceita' });
    expect(fake.recebidas[0]).toMatchObject({ method: 'PATCH', url: '/produtos/777/situacoes' });
    expect(corpo()).toEqual({ situacao: 'E' });
  });

  it('DELETE /produtos/{id}: 204 aceita, 404 ausente', async () => {
    fake.programar({ status: 204, body: '' }, { status: 404, body: '{}' });
    const cliente = adapter();
    expect(await cliente.excluirProduto('777')).toEqual({ _tag: 'ExclusaoAceita' });
    expect(await cliente.excluirProduto('777')).toEqual({ _tag: 'RemotoAusente' });
  });

  it('400 do Bling (ex.: código 12) é recusa, sem o corpo do provedor no resultado', async () => {
    const segredo = 'Produto deve estar com situação excluído — detalhe remoto';
    fake.programar({ status: 400, body: JSON.stringify({ error: { fields: [{ code: 12, msg: segredo }] } }) });
    const resultado = await adapter().excluirProduto('777');
    expect(resultado).toEqual({ _tag: 'RemotoRecusou', status: 400 });
    expect(JSON.stringify(resultado)).not.toContain('detalhe remoto');
  });
});

describe('arquivamento de produto (PRE-003)', () => {
  it('situação I: PATCH /produtos/{id}/situacoes com { situacao: "I" } — inativo, nunca excluído', async () => {
    fake.programar({ status: 204, body: '' });
    expect(await adapter().marcarProdutoInativo('777')).toEqual({ _tag: 'EscritaAceita' });
    expect(fake.recebidas[0]).toMatchObject({ method: 'PATCH', url: '/produtos/777/situacoes' });
    expect(corpo()).toEqual({ situacao: 'I' });
  });

  it('a leitura do produto traz a situação do Bling; fora do contrato é indeterminado', async () => {
    fake.programar(
      { status: 200, body: JSON.stringify({ data: { id: 777, situacao: 'I' } }) },
      { status: 200, body: JSON.stringify({ data: { id: 777, situacao: 'Z' } }) },
    );
    const cliente = adapter();
    expect(await cliente.consultarProduto('777')).toEqual({ _tag: 'RemotoPresente', valor: { id: '777', imagens: 0, situacao: 'I' } });
    expect(await cliente.consultarProduto('777')).toMatchObject({ _tag: 'RemotoIndeterminado' });
  });
});

describe('leitura do produto', () => {
  it('conta imagens internas e externas', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 777, midia: { imagens: { internas: [{ link: 'a' }, { link: 'b' }], externas: [], imagensURL: [] } } } }) });
    expect(await adapter().consultarProduto('777')).toEqual({ _tag: 'RemotoPresente', valor: { id: '777', imagens: 2, situacao: null } });
    expect(fake.recebidas[0]).toMatchObject({ method: 'GET', url: '/produtos/777' });
  });

  it('sem midia são zero imagens; 404 é ausente; corpo fora do contrato é indeterminado', async () => {
    fake.programar(
      { status: 200, body: JSON.stringify({ data: { id: 777 } }) },
      { status: 404, body: '{}' },
      { status: 200, body: JSON.stringify({ data: { nome: 'sem id' } }) },
    );
    const cliente = adapter();
    expect(await cliente.consultarProduto('777')).toEqual({ _tag: 'RemotoPresente', valor: { id: '777', imagens: 0, situacao: null } });
    expect(await cliente.consultarProduto('777')).toEqual({ _tag: 'RemotoAusente' });
    expect(await cliente.consultarProduto('777')).toEqual({ _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' });
  });
});

describe('imagens do produto', () => {
  it('limpar: PATCH com imagensURL vazio — nada além de midia', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 777 } }) });
    expect(await adapter().limparImagensDoProduto('777')).toEqual({ _tag: 'EscritaAceita' });
    expect(fake.recebidas[0]).toMatchObject({ method: 'PATCH', url: '/produtos/777' });
    expect(corpo()).toEqual({ midia: { imagens: { imagensURL: [] } } });
  });

  it('importar: PATCH com exatamente uma URL — nada além de midia', async () => {
    fake.programar({ status: 200, body: JSON.stringify({ data: { id: 777 } }) });
    expect(await adapter().importarImagemDoProduto('777', URL_ASSINADA)).toEqual({ _tag: 'EscritaAceita' });
    expect(corpo()).toEqual({ midia: { imagens: { imagensURL: [{ link: URL_ASSINADA }] } } });
  });

  it.each([
    [400, { _tag: 'RemotoRecusou', status: 400 }],
    [500, { _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' }],
    [404, { _tag: 'RemotoAusente' }],
  ])('HTTP %i na importação é classificado sem o corpo remoto', async (status, esperado) => {
    fake.programar({ status, body: JSON.stringify({ error: { description: 'corpo remoto sensível' } }) });
    const resultado = await adapter().importarImagemDoProduto('777', URL_ASSINADA);
    expect(resultado).toEqual(esperado);
    expect(JSON.stringify(resultado)).not.toContain('sensível');
    expect(JSON.stringify(resultado)).not.toContain('capacidade-temporaria');
  });

  it('429 que persiste depois do retry é limite', async () => {
    fake.programar(
      { status: 429, body: '', headers: { 'Retry-After': '0' } },
      { status: 429, body: '', headers: { 'Retry-After': '0' } },
    );
    expect(await adapter().limparImagensDoProduto('777')).toEqual({ _tag: 'RemotoLimitado' });
  });

  it('falha de rede é indeterminada', async () => {
    const cliente = adapter();
    Object.defineProperty(cliente, 'baseUrl', { value: 'http://127.0.0.1:9', configurable: true });
    expect(await cliente.importarImagemDoProduto('777', URL_ASSINADA)).toEqual({ _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' });
  });

  it('401 renova o token uma vez e repete a escrita com o token novo', async () => {
    const renovacoes: string[] = [];
    const cliente = BlingClient.comPortas(`${ORG}-401`, {
      dormir: async () => {},
      token: {
        obter: async () => ({ _tag: 'TokenObtido', token: 'token-velho' }),
        renovar: async () => { renovacoes.push('renovou'); return { _tag: 'TokenObtido', token: 'token-novo' }; },
      },
    });
    fake.programar({ status: 401, body: '{}' }, { status: 200, body: JSON.stringify({ data: { id: 777 } }) });

    expect(await cliente.importarImagemDoProduto('777', URL_ASSINADA)).toEqual({ _tag: 'EscritaAceita' });
    expect(renovacoes).toEqual(['renovou']);
    expect(fake.recebidas.map((r) => r.authorization)).toEqual(['Bearer token-velho', 'Bearer token-novo']);
  });
});
