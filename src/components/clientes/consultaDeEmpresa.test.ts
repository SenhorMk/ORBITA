import { describe, expect, it } from 'vitest';

import type { EmpresaCompleta } from '@/lib/empresas/empresaContract';

import {
  consultarCnpj,
  documentoCorrespondeAEmpresa,
  intencaoDaConsulta,
  preencherComEmpresa,
  valoresDaEmpresa,
  type ValoresDoFormulario,
} from './consultaDeEmpresa';

const EMPRESA: EmpresaCompleta = {
  cnpj: '11222333000181', razaoSocial: 'EMPRESA EXEMPLO LTDA', nomeFantasia: 'EMPRESA EXEMPLO', situacao: 'ATIVA',
  email: 'contato@exemplo.com.br', telefone: '4232220000', cep: '84010000', logradouro: 'RUA XV', numero: '100',
  bairro: 'CENTRO', municipio: 'PONTA GROSSA', uf: 'PR',
};
const OUTRA: EmpresaCompleta = {
  ...EMPRESA, cnpj: '33000167000101', razaoSocial: 'OUTRA SA', nomeFantasia: null, email: null, numero: null, municipio: 'RIO DE JANEIRO', uf: 'RJ',
};
const VAZIO: ValoresDoFormulario = { nome: '', cpfCnpj: '', email: '', telefone: '', cep: '', endereco: '', numero: '', bairro: '', cidade: '', uf: '' };

describe('o que a pessoa digitou no campo de consulta', () => {
  it('CNPJ válido, com ou sem máscara: consulta direta pelos dígitos', () => {
    expect(intencaoDaConsulta('11.222.333/0001-81')).toEqual({ _tag: 'Cnpj', cnpj: '11222333000181' });
    expect(intencaoDaConsulta(' 11222333000181 ')).toEqual({ _tag: 'Cnpj', cnpj: '11222333000181' });
  });

  it('14 dígitos com verificador errado ou repetidos: inválido, NUNCA busca por nome', () => {
    expect(intencaoDaConsulta('11222333000180')).toEqual({ _tag: 'CnpjInvalido' });
    expect(intencaoDaConsulta('11.111.111/1111-11')).toEqual({ _tag: 'CnpjInvalido' });
    expect(intencaoDaConsulta('112223330001811')).toEqual({ _tag: 'CnpjInvalido' });
  });

  it('incompleto espera; vazio é ocioso; letras não são CNPJ', () => {
    expect(intencaoDaConsulta('11.222.333/0001-8')).toEqual({ _tag: 'Incompleto' });
    expect(intencaoDaConsulta('   ')).toEqual({ _tag: 'Vazio' });
    expect(intencaoDaConsulta('padaria')).toEqual({ _tag: 'NaoCnpj' });
    expect(intencaoDaConsulta('1122233300018a')).toEqual({ _tag: 'NaoCnpj' });
  });
});

describe('preenchimento', () => {
  it('cada campo recebe o dado da consulta; nome = razão social oficial', () => {
    expect(valoresDaEmpresa(EMPRESA)).toEqual({
      nome: 'EMPRESA EXEMPLO LTDA', cpfCnpj: '11.222.333/0001-81', email: 'contato@exemplo.com.br', telefone: '4232220000',
      cep: '84010000', endereco: 'RUA XV', numero: '100', bairro: 'CENTRO', cidade: 'PONTA GROSSA', uf: 'PR',
    });
  });

  it('formulário vazio: preenche tudo, nada mantido, nada substituído', () => {
    const r = preencherComEmpresa(VAZIO, {}, EMPRESA);
    expect(r.valores).toEqual(valoresDaEmpresa(EMPRESA));
    expect(r.mantidos).toEqual([]);
    expect(r.documentoSubstituido).toBeNull();
  });

  it('parcialmente preenchido: o que a pessoa digitou fica e volta em `mantidos`', () => {
    const r = preencherComEmpresa({ ...VAZIO, email: 'compras@cliente.com', telefone: '' }, {}, EMPRESA);
    expect(r.valores.email).toBe('compras@cliente.com');
    expect(r.valores.telefone).toBe('4232220000');
    expect(r.mantidos).toEqual(['email']);
  });

  it('o mesmo valor digitado que a consulta traria não é "mantido"', () => {
    expect(preencherComEmpresa({ ...VAZIO, uf: 'PR' }, {}, EMPRESA).mantidos).toEqual([]);
  });

  it('razão social anterior diferente, digitada pela pessoa: mantida e listada, sem silêncio', () => {
    const r = preencherComEmpresa({ ...VAZIO, nome: 'Loja da Esquina' }, {}, EMPRESA);
    expect(r.valores.nome).toBe('Loja da Esquina');
    expect(r.mantidos).toEqual(['nome']);
  });

  it('CNPJ anterior DIFERENTE digitado: o CNPJ consultado identifica a empresa, e a troca é declarada', () => {
    const r = preencherComEmpresa({ ...VAZIO, cpfCnpj: '33.000.167/0001-01' }, {}, EMPRESA);
    expect(r.valores.cpfCnpj).toBe('11.222.333/0001-81');
    expect(r.documentoSubstituido).toBe('33.000.167/0001-01');
    expect(r.mantidos).not.toContain('cpfCnpj');
  });

  it('documento inválido digitado antes também é substituído e declarado', () => {
    const r = preencherComEmpresa({ ...VAZIO, cpfCnpj: '123' }, {}, EMPRESA);
    expect(r.valores.cpfCnpj).toBe('11.222.333/0001-81');
    expect(r.documentoSubstituido).toBe('123');
  });

  it('mesmo CNPJ digitado antes (com outra máscara): nada a declarar', () => {
    expect(preencherComEmpresa({ ...VAZIO, cpfCnpj: '11222333000181' }, {}, EMPRESA).documentoSubstituido).toBeNull();
  });

  it('empresa A → empresa B: troca o que A pôs, mantém o que a pessoa editou depois, e o CNPJ vira o de B', () => {
    const a = preencherComEmpresa(VAZIO, {}, EMPRESA);
    const editado = { ...a.valores, numero: '200' };
    const b = preencherComEmpresa(editado, a.daBusca, OUTRA);
    expect(b.valores.nome).toBe('OUTRA SA');
    expect(b.valores.cpfCnpj).toBe('33.000.167/0001-01');
    expect(b.valores.cidade).toBe('RIO DE JANEIRO');
    // A tinha e-mail; B não tem: o campo que era de A esvazia, em vez de ficar com o e-mail de A.
    expect(b.valores.email).toBe('');
    expect(b.valores.numero).toBe('200');
    expect(b.mantidos).toEqual(['numero']);
    // O CNPJ que A pôs não é "da pessoa": a troca para B não precisa de aviso.
    expect(b.documentoSubstituido).toBeNull();
  });

  it('o formulário corresponde à empresa enquanto o CPF/CNPJ for o dela', () => {
    expect(documentoCorrespondeAEmpresa('11.222.333/0001-81', EMPRESA)).toBe(true);
    expect(documentoCorrespondeAEmpresa('33.000.167/0001-01', EMPRESA)).toBe(false);
    expect(documentoCorrespondeAEmpresa('', EMPRESA)).toBe(false);
  });
});

describe('chamada à rota do ORBITA', () => {
  const responder = (corpo: unknown, status = 200) => async () => new Response(JSON.stringify(corpo), { status });

  it('vai à rota do ORBITA com os dígitos, nunca a um provedor externo', async () => {
    const urls: string[] = [];
    await consultarCnpj('11.222.333/0001-81', async (url) => { urls.push(url); return new Response(JSON.stringify({ resultado: 'EmpresaNaoEncontrada' }), { status: 404 }); });
    expect(urls).toEqual(['/api/empresas/cnpj/11222333000181']);
  });

  it('resposta fora do contrato, vazia ou não-JSON vira indisponível, sem eco do corpo', async () => {
    expect(await consultarCnpj('11222333000181', responder({ success: false, error: 'detalhe interno' }, 401))).toEqual({ resultado: 'ConsultaIndisponivel' });
    expect(await consultarCnpj('11222333000181', async () => new Response('<html>', { status: 502 }))).toEqual({ resultado: 'ConsultaIndisponivel' });
    expect(await consultarCnpj('11222333000181', async () => new Response('', { status: 200 }))).toEqual({ resultado: 'ConsultaIndisponivel' });
  });

  it('a rota devolveu OUTRA empresa: indisponível, e nada dela chega ao formulário', async () => {
    expect(await consultarCnpj('11222333000181', responder({ resultado: 'EmpresaEncontrada', empresa: OUTRA }))).toEqual({ resultado: 'ConsultaIndisponivel' });
  });

  it('429, 403 e 503 da rota chegam como desfechos próprios', async () => {
    expect(await consultarCnpj('11222333000181', responder({ resultado: 'LimiteDeConsultas' }, 429))).toEqual({ resultado: 'LimiteDeConsultas' });
    expect(await consultarCnpj('11222333000181', responder({ resultado: 'SemPermissao' }, 403))).toEqual({ resultado: 'SemPermissao' });
    expect(await consultarCnpj('11222333000181', responder({ resultado: 'ConsultaIndisponivel' }, 503))).toEqual({ resultado: 'ConsultaIndisponivel' });
  });
});
