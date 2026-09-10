import { describe, expect, it } from 'vitest';

import { mensagemDeFalhaDeLogin } from './mensagemDeFalhaDeLogin';

describe('mensagemDeFalhaDeLogin', () => {
  it('traduz a recusa de credencial do Supabase', () => {
    expect(mensagemDeFalhaDeLogin(new Error('Invalid login credentials'))).toBe(
      'E-mail ou senha inválidos.',
    );
  });

  it('distingue e-mail não confirmado de senha errada', () => {
    // Agrupar os dois numa frase só faria a pessoa trocar a senha certa por
    // outra, várias vezes, para resolver um problema que é de confirmação.
    expect(mensagemDeFalhaDeLogin(new Error('Email not confirmed'))).toMatch(/não foi confirmado/i);
    expect(mensagemDeFalhaDeLogin(new Error('Email not confirmed'))).not.toMatch(/senha inválid/i);
  });

  it('diz que a senha nem chegou a ser conferida quando o servidor não respondeu', () => {
    // "Failed to fetch" e "senha errada" levam a ações opostas: uma pede tentar
    // de novo, a outra pede lembrar a senha. Confundi-las é pior que o inglês.
    const frase = mensagemDeFalhaDeLogin(new TypeError('Failed to fetch'));
    expect(frase).toMatch(/não foi possível falar com o servidor/i);
    expect(frase).toMatch(/não chegou a ser conferida/i);
  });

  it('reconhece o excesso de tentativas', () => {
    expect(mensagemDeFalhaDeLogin(new Error('Request rate limit reached'))).toMatch(
      /tentativas demais/i,
    );
  });

  it('deixa passar inteiro o que não reconhece, em vez de inventar uma explicação', () => {
    // Uma frase genérica bonita sobre uma causa desconhecida é uma mentira
    // curta: quem for depurar perde a única pista que existia.
    expect(mensagemDeFalhaDeLogin(new Error('Database connection terminated'))).toBe(
      'Database connection terminated',
    );
  });

  it('sobrevive a um erro que não é Error — que é o que o supabase-js costuma rejeitar', () => {
    expect(mensagemDeFalhaDeLogin({ message: 'Invalid login credentials', status: 400 })).toBe(
      'E-mail ou senha inválidos.',
    );
  });
});
