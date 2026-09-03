/**
 * Ticket 30, fatia 3 — 5ª rodada de revisão.
 *
 * O fingerprint é o que transforma "já vi este UUID antes" em "esta é a mesma
 * operação que eu já vi". Estes testes fixam as duas metades da regra:
 * conteúdo igual tem de dar o MESMO fingerprint (senão uma retentativa
 * legítima vira conflito), e qualquer mudança de intenção comercial tem de dar
 * um fingerprint DIFERENTE (senão uma venda diferente passa por retentativa).
 */
import { describe, expect, it } from 'vitest';

import { buildManualOrderRequest, type ManualOrderRequestInput } from './manualOrderContract';
import { fingerprintDaVendaManual, serializacaoCanonicaDaVendaManual } from './manualOrderFingerprint';

const CLIENTE = '11111111-1111-4111-8111-111111111111';
const PRODUTO_A = '22222222-2222-4222-8222-222222222222';
const PRODUTO_B = '33333333-3333-4333-8333-333333333333';

function venda(overrides: Partial<ManualOrderRequestInput> = {}) {
  return buildManualOrderRequest({
    syncBling: true,
    clienteId: CLIENTE,
    itens: [{ produtoId: PRODUTO_A, quantidade: 1 }],
    desconto: 0,
    frete: 0,
    ...overrides,
  });
}

describe('fingerprintDaVendaManual', () => {
  it('o mesmo conteúdo dá o mesmo fingerprint — uma retentativa legítima não pode virar conflito', async () => {
    expect(await fingerprintDaVendaManual(venda())).toBe(await fingerprintDaVendaManual(venda()));
  });

  it('a ordem dos itens na tela não é intenção comercial — não muda o fingerprint', async () => {
    const ordemA = venda({ itens: [{ produtoId: PRODUTO_A, quantidade: 1 }, { produtoId: PRODUTO_B, quantidade: 2 }] });
    const ordemB = venda({ itens: [{ produtoId: PRODUTO_B, quantidade: 2 }, { produtoId: PRODUTO_A, quantidade: 1 }] });
    expect(await fingerprintDaVendaManual(ordemA)).toBe(await fingerprintDaVendaManual(ordemB));
  });

  it('a referenciaLocal é a CHAVE, não o conteúdo — duas referências diferentes com o mesmo conteúdo têm o mesmo fingerprint', async () => {
    const comReferencia = venda({ referenciaLocal: '44444444-4444-4444-8444-444444444444' });
    const comOutra = venda({ referenciaLocal: '55555555-5555-4555-8555-555555555555' });
    expect(await fingerprintDaVendaManual(comReferencia)).toBe(await fingerprintDaVendaManual(comOutra));
  });

  describe('qualquer mudança de intenção comercial muda o fingerprint', () => {
    it.each([
      ['outro cliente', { clienteId: '99999999-9999-4999-8999-999999999999' }],
      ['outra quantidade — o cenário exato da revisão', { itens: [{ produtoId: PRODUTO_A, quantidade: 2 }] }],
      ['outro produto — idem', { itens: [{ produtoId: PRODUTO_B, quantidade: 1 }] }],
      ['um item a mais', { itens: [{ produtoId: PRODUTO_A, quantidade: 1 }, { produtoId: PRODUTO_B, quantidade: 1 }] }],
      ['desconto diferente', { desconto: 5 }],
      ['frete diferente', { frete: 12.5 }],
      ['forma de pagamento (rótulo) diferente', { formaPagamentoRotulo: 'Cartão' }],
      ['forma de pagamento (id) diferente', { formaPagamentoId: 7 }],
      ['observações diferentes — viajam no corpo enviado ao Bling', { observacoes: 'entregar depois das 18h' }],
      ['syncBling desligado — decide se existe escrita externa', { syncBling: false }],
    ] as ReadonlyArray<readonly [string, Partial<ManualOrderRequestInput>]>)('%s', async (_descricao, mudanca) => {
      expect(await fingerprintDaVendaManual(venda(mudanca))).not.toBe(await fingerprintDaVendaManual(venda()));
    });
  });

  it('ausente é distinto de vazio — observações não enviadas não colidem com observações em branco', () => {
    const semObservacoes = serializacaoCanonicaDaVendaManual(venda());
    const comObservacoesVazias = serializacaoCanonicaDaVendaManual(venda({ observacoes: '   ' }));
    // O schema faz `trim()`, então '   ' vira ''. O marcador '-' distingue.
    expect(semObservacoes).toContain('obs:-');
    expect(comObservacoesVazias).toContain('obs:');
    expect(semObservacoes).not.toBe(comObservacoesVazias);
  });

  it('é um SHA-256 hexadecimal — 64 caracteres, cabendo numa coluna de tamanho fixo', async () => {
    expect(await fingerprintDaVendaManual(venda())).toMatch(/^[0-9a-f]{64}$/u);
  });
});
