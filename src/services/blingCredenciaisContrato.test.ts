import { describe, expect, it, vi } from 'vitest';

import { registrarFalhaInterna } from '../lib/observability/falhaInterna';

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

describe('erroRegistravel — conferido na saída do logger', () => {
  // **A prova é o que o log registra, não o objeto intermediário.**
  //
  // A versão anterior conferia `erroRegistravel(...).message`, e ficava verde
  // enquanto o log saía com `codigo: undefined`: `registrarFalhaInterna` lê
  // `erro.code` e ignora `Error.message`. Um teste sobre o valor de retorno de
  // um helper não prova o que o sistema registra.
  function registrar(erro: unknown): Record<string, unknown> {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registrarFalhaInterna('teste.credenciais', erroRegistravel(erro));
      const linha = espia.mock.calls.at(-1)?.[0];
      if (typeof linha !== 'string') throw new Error('o logger não escreveu nada');
      return JSON.parse(linha) as Record<string, unknown>;
    } finally {
      espia.mockRestore();
    }
  }

  it('o código do Postgres chega ao log', () => {
    const registrado = registrar(ERRO_DO_POSTGREST);
    expect(registrado.codigo).toBe('42501');
    expect(registrado.operacao).toBe('teste.credenciais');
  });

  it('details e hint não chegam ao log', () => {
    // CWE-209, a política do ticket 22: o código diz o que aconteceu; `details`
    // e `hint` do Postgres citam a linha que causou o erro.
    const registrado = JSON.stringify(registrar(ERRO_DO_POSTGREST));
    expect(registrado).not.toContain('linha 7');
    expect(registrado).not.toContain('policy');
    expect(registrado).not.toContain('permission denied');
  });

  it('a classe do erro chega ao log — não vira UnknownError', () => {
    // O objeto do PostgREST é objeto simples; sem virar `Error`, o log gravava
    // `UnknownError` e perdia a distinção entre falhas.
    expect(registrar(ERRO_DO_POSTGREST).erro).toBe('Error');
  });

  it('código fora da forma do SQLSTATE não é inventado no log', () => {
    // `PGRST116` tem oito caracteres e o logger o descarta. Deixar a mensagem
    // afirmar um código que o log não tem seria a mesma classe de defeito:
    // afirmação maior que o registro.
    const registrado = registrar({ code: 'PGRST116', message: 'nada encontrado' });
    expect(registrado.codigo).toBeUndefined();
    expect(JSON.stringify(registrado)).not.toContain('PGRST116');
  });

  it('erro sem código vira Error registrável mesmo assim', () => {
    expect(registrar({ message: 'sem code' }).erro).toBe('Error');
    expect(registrar(null).codigo).toBeUndefined();
  });
});
