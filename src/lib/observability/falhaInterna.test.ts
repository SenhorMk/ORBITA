import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { classificarErro, registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from './falhaInterna';

describe('registrarFalhaInterna', () => {
  let saida: string[];

  beforeEach(() => {
    saida = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      saida.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // O que o Postgres coloca em `message`, `details` e `hint` é dado de linha:
  // `Key (email)=(alguem@empresa.com) already exists`. O log é durável e é lido
  // por gente que não deveria ver o dado do cliente, então nada disso entra.
  it('não registra message, details nem hint', () => {
    registrarFalhaInterna(
      'organizacoes.convites.criar',
      Object.assign(
        new Error('duplicate key value violates unique constraint Key (email)=(alvo@empresa.com) already exists'),
        { code: '23505', details: 'linha em conflito', hint: 'use outro e-mail' },
      ),
      { organizacaoId: 'org-1', atorId: 'ator-1' },
    );

    const linha = saida.join('\n');
    expect(linha).not.toContain('alvo@empresa.com');
    expect(linha).not.toContain('linha em conflito');
    expect(linha).not.toContain('use outro e-mail');
  });

  // `Error.name` é gravável, e a redação por padrão não alcança PII arbitrária:
  // não existe forma reconhecível de "e-mail de cliente" como existe de `Bearer …`.
  // Por isso o nome não é lido — o erro é classificado por `instanceof`.
  it('não registra um name gravado com conteúdo arbitrário', () => {
    const comEmail = Object.assign(new Error('falhou'), { name: 'alvo@empresa.com' });
    const comToken = Object.assign(new Error('falhou'), {
      name: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.cargaUtil.assinatura',
    });
    const comValorDeLinha = Object.assign(new Error('falhou'), {
      name: 'Key (email)=(alvo@empresa.com) already exists',
    });

    registrarFalhaInterna('organizacoes.convites.criar', comEmail);
    registrarFalhaInterna('organizacoes.convites.criar', comToken);
    registrarFalhaInterna('organizacoes.convites.criar', comValorDeLinha);

    const linha = saida.join('\n');
    expect(linha).not.toContain('alvo@empresa.com');
    expect(linha).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(linha).not.toContain('already exists');
  });

  it('classifica por construtor, e não pelo nome que o objeto declara', () => {
    expect(classificarErro(Object.assign(new TypeError('x'), { name: 'alvo@empresa.com' }))).toBe('TypeError');
    expect(classificarErro(new RangeError('x'))).toBe('RangeError');
    expect(classificarErro(new SyntaxError('x'))).toBe('SyntaxError');
    expect(classificarErro(new ReferenceError('x'))).toBe('ReferenceError');
    // Fora da lista fechada: sai o rótulo genérico, nunca o nome declarado.
    expect(classificarErro(Object.assign(new Error('x'), { name: 'alvo@empresa.com' }))).toBe('Error');
    class ErroDoAplicativo extends Error {}
    expect(classificarErro(new ErroDoAplicativo('x'))).toBe('Error');
  });

  it('classifica como UnknownError o que não é Error', () => {
    expect(classificarErro('alvo@empresa.com')).toBe('UnknownError');
    expect(classificarErro({ name: 'alvo@empresa.com' })).toBe('UnknownError');
    expect(classificarErro(null)).toBe('UnknownError');
    expect(classificarErro(undefined)).toBe('UnknownError');
  });

  it('não registra nada de um objeto lançado que só se parece com um erro', () => {
    registrarFalhaInterna('convites.aceitar', {
      name: 'alvo@empresa.com',
      message: 'Key (email)=(alvo@empresa.com) already exists',
    });

    const linha = saida.join('\n');
    expect(linha).not.toContain('alvo@empresa.com');
    expect(linha).toContain('UnknownError');
  });

  it('registra a operação, o contexto de negócio, a classe do erro e o SQLSTATE', () => {
    registrarFalhaInterna(
      'organizacoes.membros.revogar',
      Object.assign(new TypeError('qualquer coisa'), { code: '42501' }),
      { organizacaoId: 'org-1' },
    );

    const linha = saida.join('\n');
    expect(linha).toContain('organizacoes.membros.revogar');
    expect(linha).toContain('org-1');
    expect(linha).toContain('TypeError');
    expect(linha).toContain('42501');
  });

  // `code` é atributo de um objeto vindo de fora: um authorization code do OAuth
  // chega exatamente assim. Só sai o que tem forma fechada de SQLSTATE.
  it('não registra um code que não tenha forma de SQLSTATE', () => {
    registrarFalhaInterna(
      'convites.aceitar',
      Object.assign(new Error('falhou'), { code: 'ory_ac_5f3e9b2a1c8d4e7f' }),
    );

    expect(saida.join('\n')).not.toContain('ory_ac_5f3e9b2a1c8d4e7f');
  });

  it('a frase pública não varia com a causa', () => {
    expect(MENSAGEM_PUBLICA_DE_FALHA).toBe('Erro interno');
  });
});
