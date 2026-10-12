import { describe, expect, it } from 'vitest';

import { situacaoLocalDaSituacaoBling, situacaoDoProdutoSchema } from './produtoContract';

describe('situação do produto (PRE-003)', () => {
  it.each([
    ['A', 'ativo'],
    ['I', 'inativo'],
    ['E', undefined],
    [undefined, undefined],
    ['X', undefined],
  ] as const)('Bling %s → %s', (bling, local) => {
    expect(situacaoLocalDaSituacaoBling(bling)).toBe(local);
  });

  it('a sincronização nunca grava "arquivado": só o comando de arquivamento leva lá', () => {
    for (const bling of ['A', 'I', 'E', null, 'arquivado']) expect(situacaoLocalDaSituacaoBling(bling)).not.toBe('arquivado');
  });

  it('o ciclo de vida local é fechado', () => {
    expect(situacaoDoProdutoSchema.options).toEqual(['ativo', 'inativo', 'arquivado']);
    expect(situacaoDoProdutoSchema.safeParse('excluido').success).toBe(false);
  });
});
