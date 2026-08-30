import { describe, expect, it } from 'vitest';
import { mapBlingStatus } from './utils';

/**
 * `situacao.valor` de um pedido de venda é `integer` no schema oficial do
 * Bling. A função recebia esse número e fazia `status.trim()`, derrubando a
 * etapa de pedidos inteira com `e.trim is not a function` — e, mesmo se o
 * número tivesse chegado como texto, nenhum caso do `switch` por nome casaria
 * e todo pedido viraria 'Novo' em silêncio.
 */
describe('mapBlingStatus', () => {
  it('não estoura quando recebe o código numérico que o Bling realmente envia', () => {
    expect(() => mapBlingStatus(1)).not.toThrow();
  });

  it.each([
    [0, 'Pendente'],
    [1, 'Atendido'],
    [2, 'Cancelado'],
    [3, 'Em Processamento'],
    [5, 'Em Processamento'],
    [6, 'Em Processamento'],
    [7, 'Pendente'],
    [8, 'A Emitir'],
    [10, 'Novo'],
    [11, 'A Emitir'],
    [12, 'Em Processamento'],
  ])('código %i vira %s', (codigo, esperado) => {
    expect(mapBlingStatus(codigo)).toBe(esperado);
  });

  it('trata um código que chegou como texto igual ao número', () => {
    expect(mapBlingStatus('1')).toBe('Atendido');
    expect(mapBlingStatus('2')).toBe('Cancelado');
  });

  it('continua entendendo os rótulos que o webhook e o financeiro enviam', () => {
    expect(mapBlingStatus('Atendido')).toBe('Atendido');
    expect(mapBlingStatus('em aberto')).toBe('Pendente');
    expect(mapBlingStatus('  Cancelado  ')).toBe('Cancelado');
  });

  it('cai em Novo para ausente, vazio e código desconhecido', () => {
    expect(mapBlingStatus()).toBe('Novo');
    expect(mapBlingStatus(null)).toBe('Novo');
    expect(mapBlingStatus('')).toBe('Novo');
    expect(mapBlingStatus(999)).toBe('Novo');
    expect(mapBlingStatus('situação que o Bling inventou ontem')).toBe('Novo');
  });

  it('o código 0 não é confundido com ausência de status', () => {
    // `if (!status)` tratava 0 como "sem situação" e devolvia 'Novo'.
    expect(mapBlingStatus(0)).toBe('Pendente');
  });
});
