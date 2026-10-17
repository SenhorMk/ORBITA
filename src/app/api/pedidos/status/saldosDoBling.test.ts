import { describe, expect, it } from 'vitest';

import { saldosComprovados } from './saldosDoBling';

describe('saldosComprovados: ausência nunca vira zero (PRE-006C, revisão)', () => {
  it('zero informado pelo Bling é zero, e saldoFisicoTotal tem precedência', () => {
    const saldos = saldosComprovados([
      { produto: { id: 100 }, saldoFisicoTotal: 0, saldoFisico: 7 },
      { produto: { id: '200' }, saldoFisico: 0 },
      { produto: { id: 300 }, saldoFisicoTotal: 12 },
    ]);

    expect([...saldos]).toEqual([['100', 0], ['200', 0], ['300', 12]]);
  });

  it('sem saldo, null, texto, fração, NaN ou infinito: o produto fica fora do mapa', () => {
    const saldos = saldosComprovados([
      { produto: { id: 1 } },
      { produto: { id: 2 }, saldoFisicoTotal: null },
      { produto: { id: 3 }, saldoFisico: '5' },
      { produto: { id: 4 }, saldoFisicoTotal: 2.5 },
      { produto: { id: 5 }, saldoFisicoTotal: Number.NaN },
      { produto: { id: 6 }, saldoFisicoTotal: Number.POSITIVE_INFINITY },
      // `saldoFisicoTotal` presente e inválido não recai em `saldoFisico`.
      { produto: { id: 7 }, saldoFisicoTotal: null, saldoFisico: 3 },
    ]);

    expect(saldos.size).toBe(0);
  });

  it('formato desconhecido ou id inválido é ignorado', () => {
    expect(saldosComprovados([null, 'x', 42, { saldoFisicoTotal: 3 }, { produto: { id: 'LOCAL-1' }, saldoFisicoTotal: 3 }, { produto: { id: 0 }, saldoFisicoTotal: 3 }]).size).toBe(0);
  });

  it('o mesmo produto com saldos diferentes é ambíguo e fica de fora; repetido igual vale', () => {
    const saldos = saldosComprovados([
      { produto: { id: 1 }, saldoFisicoTotal: 4 },
      { produto: { id: 1 }, saldoFisicoTotal: 5 },
      { produto: { id: 2 }, saldoFisicoTotal: 3 },
      { produto: { id: 2 }, saldoFisicoTotal: 3 },
    ]);

    expect([...saldos]).toEqual([['2', 3]]);
  });
});
