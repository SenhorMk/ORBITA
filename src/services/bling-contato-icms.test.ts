import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';
import type { BlingPort, ContatoLegadoEntrada } from './blingPort';

/**
 * PRE-010 — o cadastro de contato não deduz a situação de ICMS.
 *
 * Antes, `createContato` mandava `indicadorIe = 1` para todo documento de 14
 * dígitos e `9` para o resto, e `tipo = 'F'` quando nada vinha. Ter CNPJ não
 * diz se a empresa é contribuinte, isenta ou não contribuinte; o padrão `9`
 * era só outra dedução.
 *
 * O que se confere é o corpo que sai pelo fio, contra um servidor HTTP falso:
 * nenhuma chamada real ao Bling.
 */

const fake = new BlingFake();
const ORG = '11111111-1111-4111-8111-111111111111';
let BlingClient: typeof import('./bling').BlingClient;

function adapter() {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  Object.defineProperty(cliente, 'getAccessToken', {
    value: async () => 'token-de-teste',
    configurable: true,
  });
  return cliente;
}

function corpoEnviado(): Record<string, unknown> {
  const ultima = fake.recebidas.at(-1);
  if (!ultima) throw new Error('nenhuma requisição capturada');
  return JSON.parse(ultima.body) as Record<string, unknown>;
}

const CNPJ = '11222333000181';
const CPF = '12345678909';

type EntradaDaVenda = Parameters<BlingPort['criarContatoParaVenda']>[0];

function daVenda(overrides: Partial<EntradaDaVenda>): EntradaDaVenda {
  return { nome: 'Cliente Sintético', email: null, telefone: null, documento: CNPJ, tipo: 'J', indicadorIe: 1, ...overrides };
}

beforeAll(async () => {
  const baseUrl = await fake.iniciar();
  vi.stubEnv('BLING_API_BASE_URL', baseUrl);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://icms-test-000000.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'icms-test-service-role-key-000000');
  ({ BlingClient } = await import('./bling'));
});

afterEach(() => {
  fake.limpar();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fake.parar();
});

describe('criarContatoParaVenda: tipo e indicador vão como foram escolhidos', () => {
  it.each([
    ['CNPJ contribuinte', CNPJ, 'J', 1],
    ['CNPJ isento', CNPJ, 'J', 2],
    ['CNPJ não contribuinte', CNPJ, 'J', 9],
    ['CPF não contribuinte', CPF, 'F', 9],
    ['CPF contribuinte (produtor rural)', CPF, 'F', 1],
  ] as const)('%s', async (_caso, documento, tipo, indicadorIe) => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 77 } }) });

    const resultado = await adapter().criarContatoParaVenda(daVenda({ documento, tipo, indicadorIe }));

    expect(resultado).toEqual({ _tag: 'BlingOk', value: { id: 77 } });
    expect(corpoEnviado()).toMatchObject({ numeroDocumento: documento, tipo, indicadorIe });
  });

  // Tipo e indicador são independentes: nenhum corrige o outro, e o documento
  // não corrige nenhum dos dois.
  it.each([
    ['J com 9', CNPJ, 'J', 9],
    ['F com 1', CPF, 'F', 1],
    ['F com CNPJ e 2', CNPJ, 'F', 2],
    ['E sem documento e 9', null, 'E', 9],
  ] as const)('divergência entre tipo, documento e indicador é preservada: %s', async (_caso, documento, tipo, indicadorIe) => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 78 } }) });

    await adapter().criarContatoParaVenda(daVenda({ documento, tipo, indicadorIe }));

    expect(corpoEnviado().tipo).toBe(tipo);
    expect(corpoEnviado().indicadorIe).toBe(indicadorIe);
  });

  it.each([
    ['indicador ausente', { indicadorIe: undefined }],
    ['tipo ausente', { tipo: undefined }],
    ['indicador fora do contrato (0)', { indicadorIe: 0 }],
    ['indicador em texto ("1")', { indicadorIe: '1' }],
    ['tipo inventado', { tipo: 'X' }],
  ])('%s: recusa tipada e nenhuma requisição sai', async (_caso, sobrescrita) => {
    // SAFETY: o cast simula um chamador que escapou do tipo (JS, `as`, dado de
    // banco): é exatamente o que a validação em tempo de execução precisa barrar.
    const entrada = { ...daVenda({}), ...sobrescrita } as unknown as EntradaDaVenda;

    const resultado = await adapter().criarContatoParaVenda(entrada);

    expect(resultado._tag).toBe('BlingFailed');
    expect(fake.recebidas).toHaveLength(0);
  });
});

describe('createContato (fornecedores): sem padrão e sem dedução', () => {
  it('preserva o indicador informado', async () => {
    fake.programar({ status: 201, body: JSON.stringify({ data: { id: 90 } }) });

    await adapter().createContato({ nome: 'Fornecedor', cnpj: CNPJ, tipo: 'J', indicadorIe: 2 });

    expect(corpoEnviado()).toMatchObject({ numeroDocumento: CNPJ, tipo: 'J', indicadorIe: 2 });
  });

  // Contraprovas: cada uma reprova a volta de uma dedução removida.
  it.each([
    ['14 dígitos → 1', { nome: 'Empresa', cnpj: CNPJ }],
    ['14 dígitos com máscara → 1', { nome: 'Empresa', cnpj: '11.222.333/0001-81' }],
    ['padrão 9 sem documento', { nome: 'Pessoa' }],
    ['padrão 9 com CPF', { nome: 'Pessoa', cnpj: CPF }],
    ['tipo padrão F com indicador informado', { nome: 'Pessoa', indicadorIe: 9 }],
    ['tipo J deduzido do CNPJ com indicador informado', { nome: 'Empresa', cnpj: CNPJ, indicadorIe: 1 }],
  ])('contraprova — %s: lança e nenhuma requisição sai', async (_caso, entrada) => {
    // SAFETY: entrada sem os campos obrigatórios, como a do código anterior.
    await expect(adapter().createContato(entrada as unknown as ContatoLegadoEntrada)).rejects.toThrow('nada foi enviado ao Bling');
    expect(fake.recebidas).toHaveLength(0);
  });
});
