/**
 * Ticket 30, fatia 3 — 5ª rodada de revisão.
 *
 * A revisão pediu explicitamente o caso "enviei `createPedidoVenda`, o Bling
 * pode ter criado, e a resposta não chegou". Uma falha assim NÃO pode marcar a
 * tentativa como `falhou`/reabrível, porque "não recebi resposta" não é "não
 * criou". Este arquivo fixa a fronteira com exemplos concretos.
 */
import { describe, expect, it } from 'vitest';

import type { BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';

import { classificarFalhaDeCriacaoNoBling } from './classificacaoDeFalhaBling';

function falha(overrides: Partial<BlingProviderFailure>): BlingProviderFailure {
  return {
    _tag: 'BlingProviderFailure',
    type: 'VALIDATION_ERROR',
    status: 400,
    message: 'mensagem qualquer',
    duplicateSale: false,
    ...overrides,
  };
}

describe('classificarFalhaDeCriacaoNoBling', () => {
  describe('o Bling recebeu, processou e RECUSOU → Definitiva (nada foi criado, seguro reabrir)', () => {
    it.each([
      ['400 VALIDATION_ERROR — payload recusado', falha({ status: 400, type: 'VALIDATION_ERROR' })],
      ['400 recusa por venda duplicada — o caso comum e legítimo', falha({ status: 400, duplicateSale: true })],
      ['401 UNAUTHENTICATED — nem chegou a avaliar o pedido', falha({ status: 401, type: 'UNAUTHENTICATED' })],
      ['403 FORBIDDEN', falha({ status: 403, type: 'FORBIDDEN' })],
      ['404 RESOURCE_NOT_FOUND', falha({ status: 404, type: 'RESOURCE_NOT_FOUND' })],
      ['422 corpo inválido', falha({ status: 422, type: 'INVALID_REQUEST_BODY' })],
      ['429 — limitação de taxa é recusa ANTES do processamento', falha({ status: 429, type: 'TOO_MANY_REQUESTS' })],
      ['4xx com corpo fora do envelope padrão (type vira HTTP_<status>)', falha({ status: 400, type: 'HTTP_400' })],
    ])('%s', (_descricao, entrada) => {
      expect(classificarFalhaDeCriacaoNoBling(entrada)).toBe('Definitiva');
    });
  });

  describe('pode ter criado → Ambigua (bloqueia a chave, exige reconciliação)', () => {
    it.each([
      [
        'INVALID_RESPONSE — o Bling respondeu SUCESSO e o id não foi legível: o pedido existe e não sabemos qual é',
        falha({ status: 201, type: 'INVALID_RESPONSE' }),
      ],
      [
        'INVALID_RESPONSE mesmo com status 4xx — o tipo sintético manda, qualquer que seja o status',
        falha({ status: 400, type: 'INVALID_RESPONSE' }),
      ],
      ['408 — o servidor declara que não terminou de receber', falha({ status: 408, type: 'HTTP_408' })],
      ['500 — pode ter falhado DEPOIS de criar', falha({ status: 500, type: 'SERVER_ERROR' })],
      ['502 de gateway', falha({ status: 502, type: 'HTTP_502' })],
      ['503 indisponível', falha({ status: 503, type: 'HTTP_503' })],
      ['504 gateway timeout — o caso clássico de "criou e a resposta se perdeu"', falha({ status: 504, type: 'HTTP_504' })],
      ['status 0 — não houve resposta HTTP nenhuma', falha({ status: 0, type: 'UNKNOWN_ERROR' })],
      ['status fora da faixa HTTP conhecida', falha({ status: 999, type: 'UNKNOWN_ERROR' })],
      ['status negativo — formato inesperado cai no lado seguro', falha({ status: -1, type: 'UNKNOWN_ERROR' })],
    ])('%s', (_descricao, entrada) => {
      expect(classificarFalhaDeCriacaoNoBling(entrada)).toBe('Ambigua');
    });
  });
});
