import { describe, expect, it } from 'vitest';

import { classificarVinculoComBling, situacaoLocalDaSituacaoBling, situacaoDoProdutoSchema } from './produtoContract';

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

describe('classificarVinculoComBling (PRE-003)', () => {
  it.each([
    ['16714230397', { _tag: 'Bling', blingId: '16714230397' }],
    [16714230397, { _tag: 'Bling', blingId: '16714230397' }],
    [' 777 ', { _tag: 'Bling', blingId: '777' }],
    ['LOCAL-1696000000000', { _tag: 'SoLocal' }],
    ['LOCAL-', { _tag: 'Ambiguo' }],
    ['LOCAL-abc', { _tag: 'Ambiguo' }],
    ['local-123', { _tag: 'Ambiguo' }],
    ['temp_1a2b3c4d', { _tag: 'Ambiguo' }],
    ['', { _tag: 'Ambiguo' }],
    [null, { _tag: 'Ambiguo' }],
    ['0', { _tag: 'Ambiguo' }],
    ['-5', { _tag: 'Ambiguo' }],
    ['12.5', { _tag: 'Ambiguo' }],
  ] as const)('%o → %o', (valor, esperado) => {
    expect(classificarVinculoComBling(valor)).toEqual(esperado);
  });
});
