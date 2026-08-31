import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from './falhaInterna';

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
