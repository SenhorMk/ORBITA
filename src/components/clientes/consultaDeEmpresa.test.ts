import { describe, expect, it } from 'vitest';

import type { EmpresaCompleta } from '@/lib/empresas/empresaContract';

import { buscarEmpresas, consultarCnpj, intencaoDaBusca, preencherComEmpresa, valoresDaEmpresa, type ValoresDoFormulario } from './consultaDeEmpresa';

const EMPRESA: EmpresaCompleta = {
  cnpj: '11222333000181', razaoSocial: 'EMPRESA EXEMPLO LTDA', nomeFantasia: 'EMPRESA EXEMPLO', situacao: 'ATIVA',
  email: 'contato@exemplo.com.br', telefone: '4232220000', cep: '84010000', logradouro: 'RUA XV', numero: '100',
  bairro: 'CENTRO', municipio: 'PONTA GROSSA', uf: 'PR',
};
const OUTRA: EmpresaCompleta = { ...EMPRESA, cnpj: '33000167000101', razaoSocial: 'OUTRA SA', nomeFantasia: null, email: null, municipio: 'RIO DE JANEIRO', uf: 'RJ' };
const VAZIO: ValoresDoFormulario = { nome: '', cpfCnpj: '', email: '', telefone: '', cep: '', endereco: '', numero: '', bairro: '', cidade: '', uf: '' };

describe('o que a pessoa digitou', () => {
  it('CNPJ válido (com ou sem pontuação) é consulta direta; curto espera; o resto é nome', () => {
    expect(intencaoDaBusca('11.222.333/0001-81')).toEqual({ _tag: 'Cnpj', cnpj: '11222333000181' });
    expect(intencaoDaBusca('11222333000181')).toEqual({ _tag: 'Cnpj', cnpj: '11222333000181' });
    expect(intencaoDaBusca('ab')).toEqual({ _tag: 'Curto' });
    expect(intencaoDaBusca('padaria')).toEqual({ _tag: 'Nome', termo: 'padaria' });
    // 14 dígitos com verificador errado não é CNPJ: vira busca por nome.
    expect(intencaoDaBusca('11222333000180')).toEqual({ _tag: 'Nome', termo: '11222333000180' });
  });
});

describe('preenchimento', () => {
  it('cada campo recebe o dado da consulta completa; nome = razão social oficial', () => {
    expect(valoresDaEmpresa(EMPRESA)).toEqual({
      nome: 'EMPRESA EXEMPLO LTDA', cpfCnpj: '11.222.333/0001-81', email: 'contato@exemplo.com.br', telefone: '4232220000',
      cep: '84010000', endereco: 'RUA XV', numero: '100', bairro: 'CENTRO', cidade: 'PONTA GROSSA', uf: 'PR',
    });
  });

  it('formulário vazio: preenche tudo, nada mantido', () => {
    const r = preencherComEmpresa(VAZIO, {}, EMPRESA);
    expect(r.valores).toEqual(valoresDaEmpresa(EMPRESA));
    expect(r.mantidos).toEqual([]);
  });

  it('o que a pessoa digitou não é sobrescrito, e volta em `mantidos`', () => {
    const r = preencherComEmpresa({ ...VAZIO, email: 'compras@cliente.com', telefone: '' }, {}, EMPRESA);
    expect(r.valores.email).toBe('compras@cliente.com');
    expect(r.valores.telefone).toBe('4232220000');
    expect(r.mantidos).toEqual(['email']);
  });

  it('escolher outra empresa troca o que a busca anterior pôs, mas não o que a pessoa editou depois', () => {
    const primeira = preencherComEmpresa(VAZIO, {}, EMPRESA);
    const editado = { ...primeira.valores, numero: '200' };
    const segunda = preencherComEmpresa(editado, primeira.daBusca, OUTRA);
    expect(segunda.valores.nome).toBe('OUTRA SA');
    expect(segunda.valores.cidade).toBe('RIO DE JANEIRO');
    expect(segunda.valores.email).toBe('');
    expect(segunda.valores.numero).toBe('200');
    expect(segunda.mantidos).toEqual(['numero']);
  });
});

describe('chamadas às rotas do ORBITA', () => {
  const responder = (corpo: unknown, status = 200) => async () => new Response(JSON.stringify(corpo), { status });

  it('busca e consulta vão às rotas do ORBITA, nunca a um provedor externo', async () => {
    const urls: string[] = [];
    const buscar = async (url: string) => { urls.push(url); return new Response(JSON.stringify({ resultado: 'Empresas', empresas: [] })); };
    await buscarEmpresas('padaria do joão', buscar);
    await consultarCnpj('11.222.333/0001-81', async (url) => { urls.push(url); return new Response(JSON.stringify({ resultado: 'EmpresaNaoEncontrada' }), { status: 404 }); });
    expect(urls).toEqual(['/api/empresas/busca?termo=padaria%20do%20jo%C3%A3o', '/api/empresas/cnpj/11222333000181']);
  });

  it('resposta fora do contrato vira indisponível, sem eco do corpo', async () => {
    expect(await buscarEmpresas('padaria', responder({ success: false, error: 'detalhe interno' }, 401))).toEqual({ resultado: 'BuscaIndisponivel' });
    expect(await consultarCnpj('11222333000181', responder('<html>', 502))).toEqual({ resultado: 'ConsultaIndisponivel' });
  });
});
