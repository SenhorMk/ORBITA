import { describe, expect, it } from 'vitest';

import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { calcularChips, ehChipDePedido, pedidosDoChip } from './resumoDeVendas';

/**
 * As regras dos chips.
 *
 * O que estes testes protegem não é a aparência: é a afirmação. Um chip diz um
 * número sobre a operação, e um número errado ao lado de "A emitir NF-e" manda
 * alguém emitir nota que não precisa — ou deixa de mandar quando precisa.
 */

function pedido(parcial: Partial<PedidoEnriquecido> & { numero: string }): PedidoEnriquecido {
  return {
    bling_id: `bling-${parcial.numero}`,
    data: '2026-09-01T12:00:00.000Z',
    total: 100,
    status: 'Pendente',
    cliente_id: 'cli-1',
    ...parcial,
  } as PedidoEnriquecido;
}

const NOTA = { bling_id: 'nf-1', numero: '1', chave: '', status: 'Emitida', pedido_id: 'p' };

describe('chips de resumo de Vendas', () => {
  it('publica quatro chips, e nenhum deles inventa um estado que não existe', () => {
    const chips = calcularChips([], 0);

    expect(chips.map((c) => c.rotulo)).toEqual([
      'A emitir NF-e',
      'Entregue',
      'Cancelado',
      'Conflito Bling',
    ]);
    // Os nomes do mockup que não têm estado correspondente ficaram de fora.
    const rotulos = chips.map((c) => c.rotulo).join(' ');
    expect(rotulos).not.toMatch(/separação|trânsito|Aguardando pgto/i);
  });

  it('conta e soma "A emitir NF-e" pela fila que o projeto já calcula, sem o cancelado', () => {
    const pedidos = [
      pedido({ numero: '1', total: 40 }),                          // ativo, sem nota → na fila
      pedido({ numero: '2', total: 60, status: 'A Emitir' }),      // na fila
      pedido({ numero: '3', total: 999, status: 'Cancelado' }),    // cancelado nunca recebe NF-e
      pedido({ numero: '4', total: 30, nfe: NOTA }),               // já tem nota
    ];

    const chip = calcularChips(pedidos, 0).find((c) => c.id === 'a-emitir-nfe')!;

    expect(chip.tipo).toBe('fila-operacional');
    expect(chip.quantidade).toBe(2);
    expect(chip.soma).toBe(100);
  });

  it('conta "Entregue" e "Cancelado" pelos status reais', () => {
    const pedidos = [
      pedido({ numero: '1', status: 'Entregue', total: 40, nfe: NOTA }),
      pedido({ numero: '2', status: 'Entregue', total: 60, nfe: NOTA }),
      pedido({ numero: '3', status: 'Cancelado', total: 25 }),
      pedido({ numero: '4', status: 'Enviado', total: 10, nfe: NOTA }),
    ];

    const chips = calcularChips(pedidos, 0);
    const entregue = chips.find((c) => c.id === 'entregue')!;
    const cancelado = chips.find((c) => c.id === 'cancelado')!;

    expect(entregue.quantidade).toBe(2);
    expect(entregue.soma).toBe(100);
    expect(cancelado.quantidade).toBe(1);
    expect(cancelado.soma).toBe(25);
  });

  it('reconhece o cancelado pelo radical, e não por igualdade exata', () => {
    const pedidos = [pedido({ numero: '1', status: 'cancelado', total: 10 })];

    const cancelado = calcularChips(pedidos, 0).find((c) => c.id === 'cancelado')!;

    expect(cancelado.quantidade).toBe(1);
  });

  it('conta o que cada chip filtra: a contagem e a lista saem da mesma função', () => {
    const pedidos = [
      pedido({ numero: '1', total: 40 }),
      pedido({ numero: '2', status: 'Entregue', total: 60, nfe: NOTA }),
      pedido({ numero: '3', status: 'Cancelado', total: 25 }),
    ];

    for (const chip of calcularChips(pedidos, 0)) {
      if (!ehChipDePedido(chip.id)) continue;
      expect(pedidosDoChip(pedidos, chip.id)).toHaveLength(chip.quantidade);
    }
  });

  it('"Conflito Bling" conta pendências, não filtra a tabela e não mostra soma inventada', () => {
    const chip = calcularChips([pedido({ numero: '1' })], 2).find((c) => c.id === 'conflito-bling')!;

    expect(chip.tipo).toBe('atencao');
    expect(chip.quantidade).toBe(2);
    // A tentativa pendente guarda referência e fingerprint — não guarda valor.
    // "R$ 0,00" aqui seria um número inventado.
    expect(chip.soma).toBeNull();
    // Uma tentativa ambígua pode existir sem pedido local; filtrar por ela
    // devolveria tabela vazia e daria a impressão de que não há o que resolver.
    expect(chip.filtraTabela).toBe(false);
    expect(ehChipDePedido('conflito-bling')).toBe(false);
  });

  it('não trata o status "A Emitir" como equivalente da fila de NF-e', () => {
    // Um pedido ativo sem nota entra na fila mesmo com outro status; o chip é
    // uma fila operacional, não uma tradução de `pedido.status`.
    const pedidos = [pedido({ numero: '1', status: 'Entregue', total: 40 })];

    const chip = calcularChips(pedidos, 0).find((c) => c.id === 'a-emitir-nfe')!;

    expect(chip.quantidade).toBe(1);
  });
});
