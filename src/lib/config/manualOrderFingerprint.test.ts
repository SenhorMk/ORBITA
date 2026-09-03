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

  it('ausente é distinto de vazio — observações não enviadas não colidem com observações em branco', async () => {
    const semObservacoes = venda();
    // O schema faz `trim()`, então '   ' vira ''. Na v2, ausente é `null` e
    // vazio é `""` — dois valores JSON distintos, sem marcador nenhum.
    const comObservacoesVazias = venda({ observacoes: '   ' });

    expect(serializacaoCanonicaDaVendaManual(semObservacoes)).toContain('null');
    expect(serializacaoCanonicaDaVendaManual(comObservacoesVazias)).toContain('""');
    expect(await fingerprintDaVendaManual(semObservacoes)).not.toBe(await fingerprintDaVendaManual(comObservacoesVazias));
  });

  it('é um SHA-256 hexadecimal — 64 caracteres, cabendo numa coluna de tamanho fixo', async () => {
    expect(await fingerprintDaVendaManual(venda())).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('6ª rodada — injetividade: nenhum valor consegue imitar a estrutura', () => {
  it('a COLISÃO real da v1: dois payloads diferentes que geravam a MESMA string', async () => {
    // Não é um exemplo ilustrativo — é a colisão concreta que a v1 produzia.
    // A v1 juntava os campos com `|` e prefixava cada um com `<nome>:`, então
    // um texto livre contendo `|obs:` reconstruía a fronteira do campo
    // seguinte:
    //
    //   A: formaRotulo = "X|obs:Y", observacoes ausente
    //      → "…|formaRotulo:X|obs:Y|obs:-|itens:…"
    //   B: formaRotulo = "X",       observacoes = "Y|obs:-"
    //      → "…|formaRotulo:X|obs:Y|obs:-|itens:…"
    //
    // Strings idênticas ⇒ MESMO SHA-256 ⇒ duas vendas comercialmente
    // diferentes tratadas como a mesma operação. O hash não protege contra
    // isso: a colisão acontece ANTES dele.
    const a = venda({ formaPagamentoRotulo: 'X|obs:Y' });
    const b = venda({ formaPagamentoRotulo: 'X', observacoes: 'Y|obs:-' });

    expect(serializacaoCanonicaDaVendaManual(a)).not.toBe(serializacaoCanonicaDaVendaManual(b));
    expect(await fingerprintDaVendaManual(a)).not.toBe(await fingerprintDaVendaManual(b));
  });

  it('um valor que reproduz literalmente o formato dos itens não vira item', async () => {
    const comTextoQueParaceItem = venda({ observacoes: `${PRODUTO_B}x9` });
    const comItemDeVerdade = venda({
      itens: [{ produtoId: PRODUTO_A, quantidade: 1 }, { produtoId: PRODUTO_B, quantidade: 9 }],
    });

    expect(await fingerprintDaVendaManual(comTextoQueParaceItem)).not.toBe(
      await fingerprintDaVendaManual(comItemDeVerdade),
    );
  });

  it('aspas e barras invertidas no texto livre são escapadas, não confundidas com estrutura', async () => {
    const a = venda({ observacoes: 'ele disse "ok"' });
    const b = venda({ observacoes: 'ele disse \\"ok\\"' });
    const c = venda({ observacoes: 'ele disse ok' });

    const [fa, fb, fc] = await Promise.all([
      fingerprintDaVendaManual(a),
      fingerprintDaVendaManual(b),
      fingerprintDaVendaManual(c),
    ]);
    expect(new Set([fa, fb, fc]).size).toBe(3);
  });

  it('deslocar conteúdo de um campo para o vizinho muda o fingerprint', async () => {
    // O teste de fronteira clássico de serialização por concatenação: mover
    // caracteres da fronteira entre dois campos adjacentes.
    const a = venda({ formaPagamentoRotulo: 'Cartao', observacoes: 'XYZ' });
    const b = venda({ formaPagamentoRotulo: 'CartaoXYZ', observacoes: '' });

    expect(await fingerprintDaVendaManual(a)).not.toBe(await fingerprintDaVendaManual(b));
  });

  it('a serialização é um JSON válido — a estrutura é verificável, não uma string opaca', () => {
    const canonica = serializacaoCanonicaDaVendaManual(venda({ observacoes: 'com "aspas" e |pipes|' }));
    const decodificado: unknown = JSON.parse(canonica);
    expect(Array.isArray(decodificado)).toBe(true);
    expect((decodificado as unknown[])[0]).toBe('v2');
  });
});
