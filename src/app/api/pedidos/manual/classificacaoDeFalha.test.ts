/**
 * Ticket 30, fatia 3 — endurecida na 3ª rodada de revisão.
 *
 * `classificarErroDePersistencia` decide se uma compensação DESTRUTIVA
 * (cancelar um pedido no Bling) pode acontecer. Este arquivo é a regressão
 * que a revisão pediu explicitamente: a fronteira não pode ficar sustentada
 * só pela leitura do código-fonte da biblioteca instalada — precisa de
 * exemplos concretos e fixados.
 *
 * A política é DEFENSIVA: só uma falha POSITIVAMENTE reconhecida é
 * `Definitiva`. Qualquer coisa não reconhecida — incluindo formatos de erro
 * inéditos, campos ausentes, ou tipos inesperados — cai em `Ambigua`. Os
 * testes abaixo cobrem os três casos que a revisão pediu, e depois um
 * conjunto de formatos "desconhecidos" para provar o lado padrão da política.
 */
import { describe, expect, it } from 'vitest';

import { classificarErroDePersistencia } from './classificacaoDeFalha';

describe('classificarErroDePersistencia', () => {
  describe('erro PostgreSQL/PostgREST reconhecido e respondido pelo servidor → Definitiva', () => {
    it.each([
      ['23505 — violação de índice único (a guarda da migration 57)', { code: '23505', message: 'duplicate key value violates unique constraint' }],
      ['22023 — argumento inválido', { code: '22023', message: 'invalid input syntax' }],
      ['P0002 — no_data_found (RAISE EXCEPTION com este código)', { code: 'P0002', message: 'Cliente não encontrado' }],
      ['23514 — check_violation (estoque insuficiente)', { code: '23514', message: 'Estoque insuficiente para o produto' }],
      ['PGRST116 — erro estrutural do próprio PostgREST', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }],
    ])('%s', (_descricao, error) => {
      expect(classificarErroDePersistencia(error)).toBe('Definitiva');
    });
  });

  describe('timeout/falha de fetch/conexão perdida → Ambigua', () => {
    it.each([
      ['AbortError do supabase-js — code vazio, exatamente como o PostgrestBuilder monta', { code: '', message: 'AbortError: The operation was aborted' }],
      ['erro de rede genérico sem code nenhum', { message: 'FetchError: fetch failed' }],
      ['ECONNRESET — código de erro de rede do Node, não SQLSTATE', { code: 'ECONNRESET', message: 'socket hang up' }],
      ['ETIMEDOUT — idem', { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }],
    ])('%s', (_descricao, error) => {
      expect(classificarErroDePersistencia(error)).toBe('Ambigua');
    });
  });

  describe('erro/resposta inesperada que não pode ser classificada com certeza → Ambigua por padrão', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['string solta, não objeto', 'alguma falha'],
      ['número', 42],
      ['objeto sem propriedade code', { message: 'algo deu errado' }],
      ['code não é string (número)', { code: 500, message: 'erro' }],
      ['code é um UUID de trace, não um SQLSTATE', { code: 'a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6', message: 'trace id' }],
      ['code tem o formato certo mas em minúsculas — SQLSTATE é sempre maiúsculo', { code: 'p0002', message: 'erro' }],
      ['objeto vazio', {}],
      ['array', ['23505']],
    ])('%s', (_descricao, error) => {
      expect(classificarErroDePersistencia(error)).toBe('Ambigua');
    });
  });
});
