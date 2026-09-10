import { describe, expect, it } from 'vitest';

import { identidadeDeExibicao, rotuloDoMembro } from './identidadeDoMembro';

const PODE = { podeVerEmail: true };
const NAO_PODE = { podeVerEmail: false };

describe('identidadeDeExibicao', () => {
  it('prefere o nome do cadastro, para qualquer leitor', () => {
    const usuario = { email: 'dona@exemplo.com', user_metadata: { full_name: 'Mariana Haux' } };

    for (const opcoes of [PODE, NAO_PODE]) {
      expect(identidadeDeExibicao(usuario, opcoes)).toEqual({
        nome_exibicao: 'Mariana Haux',
        origem_do_nome: 'cadastro',
      });
    }
  });

  it('aceita `name` quando é lá que o nome está', () => {
    // Um usuário vindo por outro caminho tem nome de verdade nessa chave. Ler
    // uma segunda chave conhecida não é inventar nome — é procurar onde ele
    // estaria.
    expect(identidadeDeExibicao({ user_metadata: { name: 'Nome Legado' } }, NAO_PODE)).toEqual({
      nome_exibicao: 'Nome Legado',
      origem_do_nome: 'cadastro',
    });
  });

  it('ignora nome em branco: espaço não é nome', () => {
    expect(identidadeDeExibicao({ user_metadata: { full_name: '   ' } }, NAO_PODE)).toEqual({
      nome_exibicao: null,
      origem_do_nome: 'ausente',
    });
  });

  it('ignora `full_name` que não é texto, em vez de imprimir o que vier', () => {
    // A metadata é um saco aberto: qualquer integração pode ter escrito
    // qualquer coisa ali, e `String(objeto)` na tela seria "[object Object]".
    expect(identidadeDeExibicao({ user_metadata: { full_name: { nome: 'x' } } }, NAO_PODE)).toEqual({
      nome_exibicao: null,
      origem_do_nome: 'ausente',
    });
  });

  it('recorre ao e-mail apenas para quem já poderia vê-lo', () => {
    const usuario = { email: 'legado@exemplo.com', user_metadata: {} };

    expect(identidadeDeExibicao(usuario, PODE)).toEqual({
      nome_exibicao: 'legado@exemplo.com',
      origem_do_nome: 'email',
    });
    expect(identidadeDeExibicao(usuario, NAO_PODE)).toEqual({
      nome_exibicao: null,
      origem_do_nome: 'ausente',
    });
  });

  it('distingue "não tem nome" de "não deu para ler a identidade"', () => {
    // É a mesma distinção entre zero e "não sei" que a lista de membros já faz
    // ao não transformar falha de leitura em "nenhum membro". Juntar as duas
    // aqui afirmaria, sobre uma pessoa, um fato que ninguém verificou.
    expect(identidadeDeExibicao({ user_metadata: {} }, PODE).origem_do_nome).toBe('ausente');
    expect(identidadeDeExibicao(null, PODE).origem_do_nome).toBe('indisponivel');
    expect(identidadeDeExibicao(null, PODE).nome_exibicao).toBeNull();
  });

  it('não devolve nada além do nome escolhido — a metadata não sai daqui', () => {
    const identidade = identidadeDeExibicao(
      {
        email: 'dona@exemplo.com',
        user_metadata: { full_name: 'Mariana Haux', cpf: '000.000.000-00', provider_token: 'segredo' },
      },
      PODE,
    );

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
