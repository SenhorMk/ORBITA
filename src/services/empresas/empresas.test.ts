import { describe, expect, it, vi } from 'vitest';

import { consultarEmpresaPorCnpj, empresaDaBrasilApi } from './consultaPorCnpj';

const CNPJ = '11222333000181';
/** Endpoint injetado no teste; em produção ele vem da ligação da rota (servidor). */
const BASE = 'https://brasilapi.test/api/cnpj/v1';

/** O payload da BrasilAPI como ela devolve (campos que o ORBITA usa e alguns que descarta). */
const brasilApi = (extra: Record<string, unknown> = {}) => ({
  cnpj: CNPJ,
  razao_social: 'EMPRESA EXEMPLO LTDA',
  nome_fantasia: 'EMPRESA EXEMPLO',
  descricao_situacao_cadastral: 'ATIVA',
  email: 'Contato@Exemplo.com.br',
  ddd_telefone_1: '4232220000',
  cep: '84010000',
  logradouro: 'RUA XV DE NOVEMBRO',
  numero: '100',
  bairro: 'CENTRO',
  municipio: 'PONTA GROSSA',
  uf: 'pr',
  qsa: [{ nome_socio: 'FULANO' }],
  ...extra,
});

const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
const consultar = (fetch: typeof globalThis.fetch, cnpj = CNPJ) => consultarEmpresaPorCnpj(cnpj, { fetch, baseUrl: BASE });

describe('mapeamento do payload da BrasilAPI', () => {
  it('reduz ao vocabulário do ORBITA e descarta o resto (sócios etc.)', () => {
    expect(empresaDaBrasilApi(brasilApi())).toEqual({
      cnpj: CNPJ, razaoSocial: 'EMPRESA EXEMPLO LTDA', nomeFantasia: 'EMPRESA EXEMPLO', situacao: 'ATIVA',
      email: 'contato@exemplo.com.br', telefone: '4232220000', cep: '84010000', logradouro: 'RUA XV DE NOVEMBRO',
      numero: '100', bairro: 'CENTRO', municipio: 'PONTA GROSSA', uf: 'PR',
    });
  });

  it('opcionais vazios ou ausentes viram null, não string vazia', () => {
    const empresa = empresaDaBrasilApi(brasilApi({ nome_fantasia: '', email: null, numero: '', bairro: undefined }))!;
    expect(empresa.nomeFantasia).toBeNull();
    expect(empresa.email).toBeNull();
    expect(empresa.numero).toBeNull();
    expect(empresa.bairro).toBeNull();
  });

  it('sem razão social não é uma empresa utilizável', () => {
    expect(empresaDaBrasilApi(brasilApi({ razao_social: '' }))).toBeNull();
  });
});

describe('consulta por CNPJ, no servidor', () => {
  it('chama só o endpoint dado pelo servidor, com o CNPJ normalizado e prazo próprio', async () => {
    const fetch = vi.fn(async () => resposta(brasilApi()));
    expect((await consultar(fetch, '11.222.333/0001-81'))._tag).toBe('EmpresaEncontrada');
    expect(fetch).toHaveBeenCalledWith(`${BASE}/${CNPJ}`, expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  });

  it('CNPJ inválido não chega ao provedor', async () => {
    const fetch = vi.fn();
    expect(await consultar(fetch, '11.222.333/0001-80')).toEqual({ _tag: 'CnpjInvalido' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('o provedor devolveu OUTRO CNPJ: indisponível, nunca dados de outra empresa', async () => {
    expect(await consultar(async () => resposta(brasilApi({ cnpj: '33000167000101' })))).toEqual({ _tag: 'ConsultaIndisponivel', causa: 'cnpj_divergente' });
  });

  it('404 é não encontrada; 400 é inválido', async () => {
    expect(await consultar(async () => resposta({}, 404))).toEqual({ _tag: 'EmpresaNaoEncontrada' });
    expect(await consultar(async () => resposta({}, 400))).toEqual({ _tag: 'CnpjInvalido' });
  });

  it('429 e 5xx do provedor, rede, timeout, corpo vazio, JSON inválido e contrato inesperado: indisponível', async () => {
    const casos: Array<[typeof globalThis.fetch, string]> = [
      [async () => resposta({}, 429), 'http_429'],
      [async () => resposta({}, 502), 'http_502'],
      [async () => { throw new TypeError('rede'); }, 'TypeError'],
      [async () => { throw new DOMException('prazo', 'TimeoutError'); }, 'TimeoutError'],
      [async () => new Response('', { status: 200 }), 'json_invalido'],
      [async () => new Response('<html>', { status: 200 }), 'json_invalido'],
      [async () => resposta({ outra: 'coisa' }), 'contrato_inesperado'],
    ];
    for (const [fetch, causa] of casos) {
      expect(await consultar(fetch)).toEqual({ _tag: 'ConsultaIndisponivel', causa });
    }
  });
});
