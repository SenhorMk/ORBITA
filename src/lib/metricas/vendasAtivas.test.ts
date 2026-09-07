/**
 * A regra de venda ativa, medida contra o dataset REAL do staging em
 * 07/09/2026 — três pedidos de R$ 40, um deles cancelado:
 *
 *   #20  R$ 40  Bling                 Cancelado
 *   #21  R$ 40  Loja Física / Manual  venda válida
 *   #22  R$ 40  Loja Física / Manual  venda válida
 *
 * O painel mostrava R$ 120 de faturamento, R$ 50,40 de lucro e "3 pedidos a
 * emitir NF-e". Os números certos são R$ 80, R$ 33,60 e 2.
 */
import { describe, expect, it } from 'vitest';

import {
  apenasVendasAtivas,
  faturamentoNaJanela,
  pedidoContaComoVendaAtiva,
  pedidosComNfePendente,
  variacaoPercentual,
} from './vendasAtivas';

const HOJE = new Date('2026-09-07T12:00:00.000Z');
const TRINTA_DIAS = 30 * 24 * 60 * 60 * 1000;
const INICIO_30D = new Date(HOJE.getTime() - TRINTA_DIAS);

/** O dataset real do staging. */
const DATASET_STAGING = [
  { numero: '20', status: 'Cancelado', total: '40.00', data: '2026-09-02T03:00:00.000Z' },
  { numero: '21', status: 'Pendente', total: '40.00', data: '2026-09-07T03:00:00.000Z' },
  { numero: '22', status: 'Pendente', total: '40.00', data: '2026-09-07T03:00:00.000Z' },
];

describe('regra de venda ativa', () => {
  it('pedido cancelado não é venda ativa; os demais são', () => {
    expect(pedidoContaComoVendaAtiva({ status: 'Cancelado' })).toBe(false);
    expect(pedidoContaComoVendaAtiva({ status: 'Pendente' })).toBe(true);
    expect(pedidoContaComoVendaAtiva({ status: 'Entregue' })).toBe(true);
  });

  it('reconhece a variação de caixa que as duas fontes de status produzem', () => {
    // `mapBlingStatus` e a venda manual já gravaram as duas formas; uma
    // comparação estrita deixaria uma delas passar direto pela métrica.
    expect(pedidoContaComoVendaAtiva({ status: 'cancelado' })).toBe(false);
    expect(pedidoContaComoVendaAtiva({ status: 'CANCELADO' })).toBe(false);
  });

  it('status ausente não derruba a venda — só o cancelamento derruba', () => {
    expect(pedidoContaComoVendaAtiva({})).toBe(true);
    expect(pedidoContaComoVendaAtiva({ status: null })).toBe(true);
  });
});

describe('faturamento', () => {
  it('o dataset real do staging fatura R$ 80, não R$ 120', () => {
    expect(faturamentoNaJanela(DATASET_STAGING, INICIO_30D, HOJE)).toBe(80);
  });

  it('com a margem de 42% intacta, o lucro estimado passa a ser R$ 33,60', () => {
    const faturamento = faturamentoNaJanela(DATASET_STAGING, INICIO_30D, HOJE);
    expect(faturamento * 0.42).toBeCloseTo(33.6, 2);
  });

  it('pedido fora da janela não entra, mesmo sendo venda válida', () => {
    const antigo = [{ status: 'Entregue', total: '999.00', data: '2026-06-01T00:00:00.000Z' }];
    expect(faturamentoNaJanela(antigo, INICIO_30D, HOJE)).toBe(0);
  });

  it('a janela é meio-aberta: duas janelas consecutivas nunca contam o mesmo pedido', () => {
    const naFronteira = [{ status: 'Entregue', total: '10.00', data: INICIO_30D.toISOString() }];
    const anterior = new Date(HOJE.getTime() - 2 * TRINTA_DIAS);

    expect(faturamentoNaJanela(naFronteira, INICIO_30D, HOJE)).toBe(10);
    expect(faturamentoNaJanela(naFronteira, anterior, INICIO_30D)).toBe(0);
  });

  it('data ilegível não vira faturamento fantasma', () => {
    expect(faturamentoNaJanela([{ status: 'Entregue', total: '50', data: 'nao-e-data' }], INICIO_30D, HOJE)).toBe(0);
  });
});

describe('NF-e a emitir', () => {
  it('o cancelado sai da fila: 2 pendências, não 3', () => {
    const pendentes = pedidosComNfePendente(DATASET_STAGING);
    expect(pendentes.map((p) => p.numero)).toEqual(['21', '22']);
  });

  it('o critério de emissão que já existia é preservado', () => {
    const comNota = [{ status: 'Entregue', nfe: { status: 'Emitida' } }];
    expect(pedidosComNfePendente(comNota)).toEqual([]);
    expect(pedidosComNfePendente([{ status: 'A Emitir', nfe: { status: 'Emitida' } }])).toHaveLength(1);
  });
});

describe('gráficos e listas derivadas', () => {
  it('`apenasVendasAtivas` remove o cancelado sem alterar a lista original', () => {
    const original = [...DATASET_STAGING];
    expect(apenasVendasAtivas(DATASET_STAGING).map((p) => p.numero)).toEqual(['21', '22']);
    expect(DATASET_STAGING).toEqual(original);
  });
});

describe('variação entre janelas', () => {
  it('sem janela anterior não há comparação — devolve null em vez de um número inventado', () => {
    // O painel exibia "+X% vs mês anterior" calculado sobre R$ 12.500 escritos
    // no código, ao lado de um faturamento real.
    expect(variacaoPercentual(80, 0)).toBeNull();
  });

  it('com base real, calcula a variação', () => {
    expect(variacaoPercentual(80, 40)).toBe(100);
    expect(variacaoPercentual(40, 80)).toBe(-50);
  });
});
