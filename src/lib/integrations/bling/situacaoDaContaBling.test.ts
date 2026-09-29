import { describe, expect, it } from 'vitest';

import {
  codigoDaSituacaoDaContaSchema,
  projetarSituacaoDaConta,
  SITUACAO_DA_CONTA_BLING,
  type CodigoDaSituacaoDaConta,
} from './situacaoDaContaBling';

/**
 * Os sete códigos oficiais de `ContasDadosBaseDTO.situacao`. Só `2` e `5` têm
 * equivalente local provado; o resto fica `aberto`.
 */
describe('projeção da situação da conta do Bling', () => {
  it.each<[CodigoDaSituacaoDaConta, string, string]>([
    [1, 'Aberto', 'aberto'],
    [2, 'Pago', 'pago'],
    [3, 'Parcial', 'aberto'],
    [4, 'Devolvido', 'aberto'],
    [5, 'Cancelado', 'cancelado'],
    [6, 'Devolvido parcial', 'aberto'],
    [7, 'Confirmado', 'aberto'],
  ])('%i (%s) → %s', (codigo, _nome, esperado) => {
    expect(projetarSituacaoDaConta(codigo)).toBe(esperado);
  });

  it('3 Parcial nunca vira cancelado — a regressão do mapeamento antigo', () => {
    expect(projetarSituacaoDaConta(SITUACAO_DA_CONTA_BLING.parcial)).not.toBe('cancelado');
  });

  it('só 5 Cancelado vira terminal', () => {
    const terminais = ([1, 2, 3, 4, 5, 6, 7] as const).filter((c) => projetarSituacaoDaConta(c) === 'cancelado');
    expect(terminais).toEqual([5]);
  });

  it('nenhum código projeta `estornado`: o estorno não é inferido do Bling', () => {
    for (const codigo of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(projetarSituacaoDaConta(codigo)).not.toBe('estornado');
    }
  });

  it.each([0, 8, -1, 1.5, Number.NaN])('recusa o código %s, que o contrato não conhece', (codigo) => {
    expect(codigoDaSituacaoDaContaSchema.safeParse(codigo).success).toBe(false);
  });
});
