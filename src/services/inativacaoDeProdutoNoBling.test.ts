import { describe, expect, it } from 'vitest';

import type { EscritaRemota, LeituraRemota, ProdutoRemoto } from '../lib/integrations/bling/operacaoRemotaContract';

import { inativarProdutoNoBling } from './inativacaoDeProdutoNoBling';

/**
 * Tirar o produto da venda no Bling só conclui o que as respostas provam: uma
 * escrita sem resposta é decidida por uma leitura, e nunca por um segundo
 * `PATCH` às cegas.
 */

function porta(escrita: EscritaRemota, leitura: LeituraRemota<Pick<ProdutoRemoto, 'situacao'>> = { _tag: 'RemotoAusente' }) {
  const chamadas: string[] = [];
  return {
    chamadas,
    porta: {
      async marcarProdutoInativo() { chamadas.push('patch-I'); return escrita; },
      async consultarProduto() { chamadas.push('get'); return leitura; },
    },
  };
}

const presente = (situacao: 'A' | 'I' | 'E' | null) => ({ _tag: 'RemotoPresente' as const, valor: { situacao } });

describe('inativarProdutoNoBling', () => {
  it('2xx: fora da venda pela própria escrita, sem leitura', async () => {
    const p = porta({ _tag: 'EscritaAceita' });
    expect(await inativarProdutoNoBling(p.porta, '777')).toEqual({ _tag: 'ForaDaVenda', comprovadaPor: 'escrita', situacaoRemota: 'I' });
    expect(p.chamadas).toEqual(['patch-I']);
  });

  it.each([
    [{ _tag: 'RemotoRecusou', status: 400 } as const, { _tag: 'Recusada', status: 400 }],
    [{ _tag: 'RemotoLimitado' } as const, { _tag: 'Limitada' }],
  ])('%o sem leitura: %o', async (escrita, esperado) => {
    const p = porta(escrita);
    expect(await inativarProdutoNoBling(p.porta, '777')).toEqual(esperado);
    expect(p.chamadas).toEqual(['patch-I']);
  });

  it.each([
    ['ACK perdido e o Bling já inativo', presente('I'), { _tag: 'ForaDaVenda', comprovadaPor: 'consulta', situacaoRemota: 'I' }],
    ['ACK perdido e o produto excluído no Bling', presente('E'), { _tag: 'ForaDaVenda', comprovadaPor: 'consulta', situacaoRemota: 'E' }],
    ['ACK perdido e o produto ainda ativo', presente('A'), { _tag: 'AindaAtivo' }],
    ['ACK perdido e a leitura sem situação', presente(null), { _tag: 'Indeterminada' }],
    ['ACK perdido e o produto ausente (404)', { _tag: 'RemotoAusente' } as const, { _tag: 'ForaDaVenda', comprovadaPor: 'consulta', situacaoRemota: 'ausente' }],
    ['ACK perdido e a leitura também sem resposta', { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' } as const, { _tag: 'Indeterminada' }],
    ['ACK perdido e a leitura limitada', { _tag: 'RemotoLimitado' } as const, { _tag: 'Indeterminada' }],
  ] as const)('%s', async (_caso, leitura, esperado) => {
    const p = porta({ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' }, leitura);
    expect(await inativarProdutoNoBling(p.porta, '777')).toEqual(esperado);
    expect(p.chamadas).toEqual(['patch-I', 'get']);
  });

  it('404 na escrita não é prova sozinho: a leitura decide', async () => {
    const p = porta({ _tag: 'RemotoAusente' }, presente('A'));
    expect(await inativarProdutoNoBling(p.porta, '777')).toEqual({ _tag: 'AindaAtivo' });
    expect(p.chamadas).toEqual(['patch-I', 'get']);
  });
});
