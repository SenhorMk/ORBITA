import { describe, expect, it, vi } from 'vitest';

import { cnpjValido, formatarCnpj } from '@/lib/empresas/cnpj';

import { termoDeBusca, provedorDeBuscaConfigurado } from './buscaDeEmpresas';
import { consultarEmpresaPorCnpj, empresaDaBrasilApi } from './consultaPorCnpj';

const CNPJ = '11222333000181';
/** O endpoint decidido pelo servidor (em produção, `BRASILAPI_CNPJ_URL` ou o padrão da BrasilAPI). */
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

describe('CNPJ', () => {
  it('valida os dígitos verificadores e recusa sequência repetida', () => {
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
    expect(cnpjValido('11.222.333/0001-80')).toBe(false);
    expect(cnpjValido('11111111111111')).toBe(false);
    expect(cnpjValido('1122233300018')).toBe(false);
  });

  it('formata enquanto se digita', () => {
    expect(formatarCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatarCnpj('1122')).toBe('11.22');
  });
});

describe('consulta completa por CNPJ (BrasilAPI, no servidor)', () => {
  it('mapeia para o vocabulário do ORBITA e descarta o resto (sócios etc.)', () => {
    expect(empresaDaBrasilApi(brasilApi())).toEqual({
      cnpj: CNPJ,
      razaoSocial: 'EMPRESA EXEMPLO LTDA',
      nomeFantasia: 'EMPRESA EXEMPLO',
      situacao: 'ATIVA',
      email: 'contato@exemplo.com.br',
      telefone: '4232220000',
      cep: '84010000',
      logradouro: 'RUA XV DE NOVEMBRO',
      numero: '100',
      bairro: 'CENTRO',
      municipio: 'PONTA GROSSA',
      uf: 'PR',
    });
  });

  it('sem nome fantasia e com campos vazios: null, não string vazia', () => {
    const empresa = empresaDaBrasilApi(brasilApi({ nome_fantasia: '', email: null, numero: '' }))!;
    expect(empresa.nomeFantasia).toBeNull();
    expect(empresa.email).toBeNull();
    expect(empresa.numero).toBeNull();
  });

  it('chama só o endpoint decidido pelo servidor, com o CNPJ normalizado', async () => {
    const fetch = vi.fn(async () => resposta(brasilApi()));
    const r = await consultarEmpresaPorCnpj('11.222.333/0001-81', { fetch, baseUrl: BASE });
    expect(r._tag).toBe('EmpresaEncontrada');
    expect(fetch).toHaveBeenCalledWith(`${BASE}/${CNPJ}`, expect.objectContaining({ cache: 'no-store' }));
  });

  it('CNPJ inválido não chega ao provedor', async () => {
    const fetch = vi.fn();
    expect(await consultarEmpresaPorCnpj('11.222.333/0001-80', { fetch, baseUrl: BASE })).toEqual({ _tag: 'CnpjInvalido' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('404 é não encontrada; 5xx, rede e contrato inesperado são indisponível', async () => {
    expect(await consultarEmpresaPorCnpj(CNPJ, { baseUrl: BASE, fetch: async () => resposta({}, 404) })).toEqual({ _tag: 'EmpresaNaoEncontrada' });
    expect((await consultarEmpresaPorCnpj(CNPJ, { baseUrl: BASE, fetch: async () => resposta({}, 502) }))._tag).toBe('ConsultaIndisponivel');
    expect((await consultarEmpresaPorCnpj(CNPJ, { baseUrl: BASE, fetch: async () => { throw new TypeError('rede'); } }))._tag).toBe('ConsultaIndisponivel');
    expect((await consultarEmpresaPorCnpj(CNPJ, { baseUrl: BASE, fetch: async () => resposta({ outra: 'coisa' }) }))._tag).toBe('ConsultaIndisponivel');
  });
});

describe('busca por nome', () => {
  it('termo: mínimo 3, máximo 80, espaços colapsados; o resto é recusado', () => {
    expect(termoDeBusca('ab')).toBeNull();
    expect(termoDeBusca('  empresa   exemplo ')).toBe('empresa exemplo');
    expect(termoDeBusca('x'.repeat(81))).toBeNull();
    expect(termoDeBusca(['abc'])).toBeNull();
  });

  it('sem provedor contratado, não há busca por nome (o modo CNPJ segue funcionando)', () => {
    expect(provedorDeBuscaConfigurado()).toBeNull();
  });
});
