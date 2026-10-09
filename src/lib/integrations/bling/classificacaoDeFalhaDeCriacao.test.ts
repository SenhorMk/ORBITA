/**
 * Ticket 30, fatia 3 — 5ª e 6ª rodadas de revisão.
 *
 * A fronteira aqui decide se uma chave de idempotência pode REABRIR e
 * autorizar uma nova criação externa. A 6ª rodada endureceu a política: faixa
 * de status HTTP não é prova de ausência de efeito, então só um `error.type`
 * do contrato da v3 que descreva recusa da REQUISIÇÃO, junto de um status
 * `4xx`, conta como definitivo. Todo o resto é ambíguo — e ambíguo bloqueia.
 */
import { describe, expect, it } from 'vitest';

import type { BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';

import { classificarFalhaDeCriacaoNoBling } from './classificacaoDeFalhaDeCriacao';

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
  describe('o contrato PROVA recusa da requisição → Definitiva (nada foi criado, seguro reabrir)', () => {
    it.each([
      ['VALIDATION_ERROR 400 — o corpo não passou na validação', falha({ type: 'VALIDATION_ERROR', status: 400 })],
      ['BAD_REQUEST 400', falha({ type: 'BAD_REQUEST', status: 400 })],
      ['MISSING_REQUIRED_FIELD_ERROR 400', falha({ type: 'MISSING_REQUIRED_FIELD_ERROR', status: 400 })],
      ['EMPTY_REQUEST_BODY 400', falha({ type: 'EMPTY_REQUEST_BODY', status: 400 })],
      ['INVALID_REQUEST_BODY 422', falha({ type: 'INVALID_REQUEST_BODY', status: 422 })],
      ['INVALID_APIKEY_ERROR 401', falha({ type: 'INVALID_APIKEY_ERROR', status: 401 })],
      ['UNAUTHENTICATED 401', falha({ type: 'UNAUTHENTICATED', status: 401 })],
      ['UNAUTHORIZED 401', falha({ type: 'UNAUTHORIZED', status: 401 })],
      ['FORBIDDEN 403', falha({ type: 'FORBIDDEN', status: 403 })],
      ['METHOD_NOT_ALLOWED 405', falha({ type: 'METHOD_NOT_ALLOWED', status: 405 })],
      [
        'recusa por venda duplicada — é uma VALIDATION_ERROR, o caso comum e legítimo de retentativa',
        falha({ type: 'VALIDATION_ERROR', status: 400, duplicateSale: true }),
      ],
    ])('%s', (_descricao, entrada) => {
      expect(classificarFalhaDeCriacaoNoBling(entrada)).toBe('Definitiva');
    });
  });

  describe('6ª rodada — sem prova contratual de ausência de efeito → Ambigua (bloqueia a chave)', () => {
    it.each([
      [
        '429 TOO_MANY_REQUESTS — a 5ª rodada chamava de definitivo por inferência; o contrato não afirma isso',
        falha({ type: 'TOO_MANY_REQUESTS', status: 429 }),
      ],
      [
        '4xx com type NÃO reconhecido — nada no contrato prova que a criação não teve efeito',
        falha({ type: 'ALGUM_TIPO_NOVO_DO_PROVEDOR', status: 400 }),
      ],
      [
        '4xx cujo corpo não é o envelope da v3 (type vira HTTP_<status>) — não há contrato para invocar',
        falha({ type: 'HTTP_400', status: 400 }),
      ],
      ['RESOURCE_NOT_FOUND 404 — num POST de criação não é inequívoco o que faltou, nem quando', falha({ type: 'RESOURCE_NOT_FOUND', status: 404 })],
      ['408 — o servidor declara que não terminou de receber', falha({ type: 'HTTP_408', status: 408 })],
      ['500 SERVER_ERROR — pode ter falhado DEPOIS de criar', falha({ type: 'SERVER_ERROR', status: 500 })],
      ['502 de gateway', falha({ type: 'HTTP_502', status: 502 })],
      ['503 indisponível', falha({ type: 'HTTP_503', status: 503 })],
      ['504 gateway timeout — o caso clássico de "criou e a resposta se perdeu"', falha({ type: 'HTTP_504', status: 504 })],
      [
        'INVALID_RESPONSE — o Bling respondeu SUCESSO e o id não foi legível: o pedido existe e não sabemos qual é',
        falha({ type: 'INVALID_RESPONSE', status: 201 }),
      ],
      ['UNKNOWN_ERROR', falha({ type: 'UNKNOWN_ERROR', status: 0 })],
      ['NOT_IMPLEMENTED', falha({ type: 'NOT_IMPLEMENTED', status: 501 })],
      ['status 0 — não houve resposta HTTP nenhuma', falha({ type: 'VALIDATION_ERROR', status: 0 })],
      ['status fora da faixa HTTP conhecida', falha({ type: 'VALIDATION_ERROR', status: 999 })],
      ['status negativo — formato inesperado cai no lado seguro', falha({ type: 'VALIDATION_ERROR', status: -1 })],
      ['status não inteiro', falha({ type: 'VALIDATION_ERROR', status: Number.NaN })],
    ])('%s', (_descricao, entrada) => {
      expect(classificarFalhaDeCriacaoNoBling(entrada)).toBe('Ambigua');
    });
  });

  describe('os dois lados da conjunção são necessários — nunca um só', () => {
    it('tipo de recusa reconhecido, mas status 5xx: Ambigua', () => {
      expect(classificarFalhaDeCriacaoNoBling(falha({ type: 'VALIDATION_ERROR', status: 500 }))).toBe('Ambigua');
    });

    it('status 4xx, mas tipo não reconhecido: Ambigua', () => {
      expect(classificarFalhaDeCriacaoNoBling(falha({ type: 'SERVER_ERROR', status: 400 }))).toBe('Ambigua');
    });
  });
});
