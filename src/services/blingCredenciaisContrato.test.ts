import { describe, expect, it } from 'vitest';

import {
  erroRegistravel,
  lerResultadoDaConexao,
  lerResultadoDoLock,
} from './blingCredenciaisContrato';

/**
 * Ticket 31 — a tradução do Supabase para os tipos do domínio.
 *
 * Era a única fronteira do desenho novo sem prova nenhuma, e é a que todo o
 * resto pressupõe correta: os testes de `blingToken` usam armazenamento
 * dublado, então um mapeamento invertido aqui passaria por 1486 casos verdes.
 *
 * As funções são puras de propósito — o adapter faz a chamada, elas leem a
 * resposta —, e por isso dá para prová-las sem dublar módulo nenhum.
 */

/** O formato de erro do PostgREST: objeto simples, não `Error`. */
const ERRO_DO_POSTGREST = { code: '42501', message: 'permission denied', details: 'linha 7', hint: 'confira a policy' };

describe('lerResultadoDaConexao', () => {
  it('erro não é ausência de conexão', () => {
    // O defeito original: `error` descartado, `null` virando "conclua os passos
    // 1 e 2 em Integrações" — o lojista reconectando uma conta já conectada.
    expect(lerResultadoDaConexao({ data: null, error: ERRO_DO_POSTGREST })).toEqual({
      _tag: 'Indisponivel',
      causa: ERRO_DO_POSTGREST,
    });
  });

  it('sem linha é "sem conexão" de verdade', () => {
    expect(lerResultadoDaConexao({ data: null, error: null })).toEqual({ _tag: 'SemConexao' });
  });

  it('linha sem id também é "sem conexão"', () => {
    expect(lerResultadoDaConexao({ data: {}, error: null })).toEqual({ _tag: 'SemConexao' });
  });

  it('linha com id é a conexão encontrada', () => {
    expect(lerResultadoDaConexao({ data: { id: 'conexao-1' }, error: null })).toEqual({
      _tag: 'Encontrada',
      conexaoId: 'conexao-1',
    });
  });

  it('erro prevalece mesmo com dado presente', () => {
    // O PostgREST pode devolver os dois; um dado acompanhado de erro não é
    // confiável, e tratá-lo como sucesso esconderia a falha.
    expect(lerResultadoDaConexao({ data: { id: 'x' }, error: ERRO_DO_POSTGREST })._tag).toBe('Indisponivel');
  });
});

describe('lerResultadoDoLock', () => {
  it('erro é indisponível, e não "ocupado"', () => {
    // Confundir os dois faz o chamador esperar 15 tentativas por uma renovação
    // que ninguém está fazendo.
    expect(lerResultadoDoLock({ data: null, error: ERRO_DO_POSTGREST })).toEqual({
      _tag: 'Indisponivel',
      causa: ERRO_DO_POSTGREST,
    });
  });

  it('true é lock adquirido', () => {
    expect(lerResultadoDoLock({ data: true, error: null })).toEqual({ _tag: 'Adquirido' });
  });

  it('false é outro processo renovando', () => {
    // O mapeamento invertido aqui é o pior caso do módulo: duas requisições
    // renovariam ao mesmo tempo, cada uma consumindo o refresh token rotacionado
    // da outra, e a conexão morreria com `invalid_grant`.
    expect(lerResultadoDoLock({ data: false, error: null })).toEqual({ _tag: 'Ocupado' });
  });

  it('ausência de dado é tratada como ocupado, nunca como adquirido', () => {
    // Na dúvida, não assumir que o lock é nosso: esperar é recuperável,
    // renovar em paralelo não é.
    expect(lerResultadoDoLock({ data: null, error: null })).toEqual({ _tag: 'Ocupado' });
  });
});

describe('erroRegistravel', () => {
  it('preserva o código do Postgres, que é vocabulário fechado', () => {
    const erro = erroRegistravel(ERRO_DO_POSTGREST);
    expect(erro).toBeInstanceOf(Error);
    expect(erro.message).toContain('42501');
  });

  it('não carrega `details` nem `hint`, que trazem valor de linha', () => {
    // CWE-209, a política do ticket 22: o código diz o que aconteceu; `details`
    // e `hint` do Postgres citam a linha que causou o erro.
    const erro = erroRegistravel(ERRO_DO_POSTGREST);
    expect(erro.message).not.toContain('linha 7');
    expect(erro.message).not.toContain('policy');
    expect(erro.message).not.toContain('permission denied');
  });

  it('vira `Error` mesmo sem código, para a classe chegar ao log', () => {
    // `registrarFalhaInterna` grava a classe por `instanceof Error`; um objeto
    // simples do PostgREST virava sempre `UnknownError`.
    expect(erroRegistravel({ message: 'sem code' })).toBeInstanceOf(Error);
    expect(erroRegistravel(null)).toBeInstanceOf(Error);
    expect(erroRegistravel('texto').message).toContain('sem-codigo');
  });
});
