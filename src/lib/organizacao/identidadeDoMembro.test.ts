import { describe, expect, it } from 'vitest';

import { identidadeDeExibicao, rotuloDoMembro } from './identidadeDoMembro';

describe('identidadeDeExibicao', () => {
  it('usa o nome do cadastro', () => {
    expect(identidadeDeExibicao({ user_metadata: { full_name: 'Mariana Haux' } })).toEqual({
      nome_exibicao: 'Mariana Haux',
      origem_do_nome: 'cadastro',
    });
  });

  it('aceita `name` quando é lá que o nome está', () => {
    // Um usuário vindo por outro caminho tem nome de verdade nessa chave. Ler
    // uma segunda chave conhecida não é inventar nome — é procurar onde ele
    // estaria.
    expect(identidadeDeExibicao({ user_metadata: { name: 'Nome Legado' } })).toEqual({
      nome_exibicao: 'Nome Legado',
      origem_do_nome: 'cadastro',
    });
  });

  it('ignora nome em branco: espaço não é nome', () => {
    expect(identidadeDeExibicao({ user_metadata: { full_name: '   ' } })).toEqual({
      nome_exibicao: null,
      origem_do_nome: 'ausente',
    });
  });

  it('ignora `full_name` que não é texto, em vez de imprimir o que vier', () => {
    // A metadata é um saco aberto: qualquer integração pode ter escrito
    // qualquer coisa ali, e `String(objeto)` na tela seria "[object Object]".
    expect(identidadeDeExibicao({ user_metadata: { full_name: { nome: 'x' } } })).toEqual({
      nome_exibicao: null,
      origem_do_nome: 'ausente',
    });
  });

  it('nunca recorre ao e-mail — nem quando ele está no objeto recebido', () => {
    // A revisão externa recusou o recurso ao e-mail: "já é visível em outro
    // lugar" não é motivo para publicar PII em mais um. Este caso passa o campo
    // de propósito, para o dia em que alguém o reintroduzir no tipo ter um
    // teste vermelho em vez de um vazamento silencioso.
    const comEmail = { email: 'legado@exemplo.com', user_metadata: {} } as { user_metadata: unknown };

    const identidade = identidadeDeExibicao(comEmail);

    expect(identidade).toEqual({ nome_exibicao: null, origem_do_nome: 'ausente' });
    expect(JSON.stringify(identidade)).not.toContain('legado@exemplo.com');
  });

  it('distingue "não tem nome" de "não deu para ler a identidade"', () => {
    // É a mesma distinção entre zero e "não sei" que a lista de membros já faz
    // ao não transformar falha de leitura em "nenhum membro". Juntar as duas
    // aqui afirmaria, sobre uma pessoa, um fato que ninguém verificou.
    expect(identidadeDeExibicao({ user_metadata: {} }).origem_do_nome).toBe('ausente');
    expect(identidadeDeExibicao(null).origem_do_nome).toBe('indisponivel');
    expect(identidadeDeExibicao(null).nome_exibicao).toBeNull();
  });

  it('não devolve nada além do nome escolhido — a metadata não sai daqui', () => {
    const identidade = identidadeDeExibicao({
      user_metadata: { full_name: 'Mariana Haux', cpf: '000.000.000-00', provider_token: 'segredo' },
    });

    expect(Object.keys(identidade).sort()).toEqual(['nome_exibicao', 'origem_do_nome']);
    expect(JSON.stringify(identidade)).not.toContain('000.000.000-00');
    expect(JSON.stringify(identidade)).not.toContain('provider_token');
  });
});

describe('rotuloDoMembro', () => {
  it('usa o nome quando existe', () => {
    expect(rotuloDoMembro({ nome_exibicao: 'Mariana Haux', origem_do_nome: 'cadastro' })).toBe('Mariana Haux');
  });

  it('dá frases diferentes para ausência e indisponibilidade', () => {
    const ausente = rotuloDoMembro({ nome_exibicao: null, origem_do_nome: 'ausente' });
    const indisponivel = rotuloDoMembro({ nome_exibicao: null, origem_do_nome: 'indisponivel' });

    expect(ausente).toBe('Sem nome cadastrado');
    expect(indisponivel).toBe('Identidade indisponível');
    expect(ausente).not.toBe(indisponivel);
  });
});
