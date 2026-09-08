import { describe, expect, it } from 'vitest';

import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import type { DadosDoPainel } from './useLeituraDoPainel';
import { analiseDaMetrica } from './analisesDoPainel';
import {
  anelDePedidos,
  baldeDoPedido,
  celulasDoPainel,
  distribuicaoPorStatus,
  metricasLaterais,
  serieDiariaDeFaturamento,
} from './metricasDoPainel';

/**
 * As regras da Visão Geral.
 *
 * O que estes testes protegem é a mesma coisa que os dos chips de Vendas: a
 * afirmação. Um painel existe para responder perguntas sobre dinheiro e
 * operação, e um número que não fecha com o resto da tela é pior que número
 * nenhum — quem lê não tem como saber qual dos dois acreditar.
 */

const AGORA = new Date('2026-09-08T12:00:00.000Z').getTime();
const DIA = 24 * 60 * 60 * 1000;

function pedido(parcial: Partial<PedidoEnriquecido> & { numero: string }): PedidoEnriquecido {
  return {
    id: `id-${parcial.numero}`,
    bling_id: `b-${parcial.numero}`,
    data: new Date(AGORA - DIA).toISOString(),
    total: 100,
    status: 'Pendente',
    cliente_id: 'c1',
    ...parcial,
  } as PedidoEnriquecido;
}

function painel(pedidos: PedidoEnriquecido[]): DadosDoPainel {
  return {
    pedidos,
    produtos: [],
    clientes: [],
    estatisticas: {
      faturamento30Dias: 0,
      faturamento30DiasAnterior: 0,
      totalPedidos: pedidos.length,
      pendentes: 0,
      cancelados: 0,
      atendidos: 0,
    },
  };
}

describe('os quatro baldes fecham com o total', () => {
  it('classifica pelo radical do status, como o servidor', () => {
    expect(baldeDoPedido({ status: 'Pendente' })).toBe('pendentes');
    expect(baldeDoPedido({ status: 'Aberto' })).toBe('pendentes');
    expect(baldeDoPedido({ status: 'Atendido' })).toBe('atendidos');
    expect(baldeDoPedido({ status: 'cancelado' })).toBe('cancelados');
    expect(baldeDoPedido({ status: 'Cancelado' })).toBe('cancelados');
  });

  it('põe em "outros" o que os três baldes do servidor não cobrem', () => {
    // Nenhum destes cai em pendente, atendido ou cancelado — e `Entregue` é o
    // que a venda manual grava. Sem o quarto balde, a soma não fecharia.
    for (const status of ['Entregue', 'Enviado', 'Novo', 'Em Processamento', 'Despachado', 'A Emitir', 'Concluído']) {
      expect(baldeDoPedido({ status })).toBe('outros');
    }
  });

  it('as fatias do anel somam exatamente o total de pedidos', () => {
    const pedidos = [
      pedido({ numero: '1', status: 'Pendente' }),
      pedido({ numero: '2', status: 'Entregue' }),
      pedido({ numero: '3', status: 'Cancelado' }),
      pedido({ numero: '4', status: 'Atendido' }),
      pedido({ numero: '5', status: 'Enviado' }),
    ];

    const anel = anelDePedidos(pedidos);

    expect(anel.total).toBe(5);
    expect(anel.fatias.reduce((soma, f) => soma + f.quantidade, 0)).toBe(5);
    expect(anel.fatias.reduce((soma, f) => soma + f.fracao, 0)).toBeCloseTo(1, 10);
  });

  it('a distribuição por status também fecha: nenhum pedido fica de fora', () => {
    const pedidos = [
      pedido({ numero: '1', status: 'Pendente' }),
      pedido({ numero: '2', status: 'Entregue' }),
      pedido({ numero: '3', status: 'Entregue' }),
    ];

    const fatias = distribuicaoPorStatus(pedidos);

    expect(fatias.reduce((soma, f) => soma + f.quantidade, 0)).toBe(3);
  });
});

describe('a série de faturamento é medida, não repartida', () => {
  it('cada ponto é a soma dos pedidos ativos daquele dia', () => {
    const pedidos = [
      pedido({ numero: '1', total: 40, status: 'Entregue', data: new Date(AGORA - 2 * DIA).toISOString() }),
      pedido({ numero: '2', total: 60, status: 'Entregue', data: new Date(AGORA - 2 * DIA).toISOString() }),
      pedido({ numero: '3', total: 25, status: 'Entregue', data: new Date(AGORA - 5 * DIA).toISOString() }),
    ];

    const serie = serieDiariaDeFaturamento(pedidos, AGORA);
    const comValor = serie.filter((ponto) => ponto.valor > 0);

    expect(comValor).toHaveLength(2);
    expect(comValor.map((p) => p.valor).sort((a, b) => a - b)).toEqual([25, 100]);
  });

  it('não conta pedido cancelado — a série e o faturamento contam a mesma coisa', () => {
    const pedidos = [
      pedido({ numero: '1', total: 40, status: 'Entregue', data: new Date(AGORA - DIA).toISOString() }),
      pedido({ numero: '2', total: 999, status: 'Cancelado', data: new Date(AGORA - DIA).toISOString() }),
    ];

    const soma = serieDiariaDeFaturamento(pedidos, AGORA).reduce((t, p) => t + p.valor, 0);

    expect(soma).toBe(40);
  });

  it('a soma da série bate com o faturamento que a análise anuncia', () => {
    const pedidos = [
      pedido({ numero: '1', total: 40, status: 'Entregue', data: new Date(AGORA - DIA).toISOString() }),
      pedido({ numero: '2', total: 60, status: 'Entregue', data: new Date(AGORA - 10 * DIA).toISOString() }),
    ];

    const analise = analiseDaMetrica('faturamento', painel(pedidos), AGORA);
    if (analise.tipo !== 'serie') throw new Error('esperava uma série');

    const soma = analise.pontos.reduce((t, p) => t + p.valor, 0);
    expect(analise.destaque).toBe(soma.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  });
});

describe('quando não há o que medir, não se desenha curva', () => {
  it('faturamento sem venda ativa em 60 dias vira uma resposta, não um gráfico', () => {
    const analise = analiseDaMetrica('faturamento', painel([pedido({ numero: '1', status: 'Cancelado' })]), AGORA);

    expect(analise.tipo).toBe('vazia');
    if (analise.tipo !== 'vazia') return;
    expect(analise.motivo).toMatch(/não há série/i);
  });

  it('um balde vazio diz que está vazio em vez de repartir nada', () => {
    const analise = analiseDaMetrica('cancelados', painel([pedido({ numero: '1', status: 'Entregue' })]), AGORA);

    expect(analise.tipo).toBe('vazia');
  });

  it('sem pedido nenhum, a fila de NF-e não inventa itens', () => {
    const analise = analiseDaMetrica('nfe', painel([]), AGORA);

    expect(analise.tipo).toBe('vazia');
  });
});

describe('as análises usam só o que o payload tem', () => {
  it('pedidos abre a distribuição por status', () => {
    const analise = analiseDaMetrica('pedidos', painel([pedido({ numero: '1', status: 'Entregue' })]), AGORA);

    expect(analise.tipo).toBe('distribuicao');
    if (analise.tipo !== 'distribuicao') return;
    expect(analise.fatias[0].rotulo).toBe('Entregue');
  });

  it('a fila de NF-e vem do mais antigo para o mais novo', () => {
    const pedidos = [
      pedido({ numero: 'novo', status: 'A Emitir', data: new Date(AGORA - DIA).toISOString() }),
      pedido({ numero: 'antigo', status: 'A Emitir', data: new Date(AGORA - 20 * DIA).toISOString() }),
    ];

    const analise = analiseDaMetrica('nfe', painel(pedidos), AGORA);

    expect(analise.tipo).toBe('fila');
    if (analise.tipo !== 'fila') return;
    expect(analise.itens[0].numero).toBe('#antigo');
  });

  it('as sete células cobrem os quatro baldes, e os quatro somam o total', () => {
    const pedidos = [
      pedido({ numero: '1', status: 'Pendente' }),
      pedido({ numero: '2', status: 'Entregue' }),
      pedido({ numero: '3', status: 'Cancelado' }),
      pedido({ numero: '4', status: 'Atendido' }),
    ];

    const celulas = celulasDoPainel(painel(pedidos), AGORA);
    const porId = Object.fromEntries(celulas.map((c) => [c.id, c.valor]));

    expect(celulas).toHaveLength(7);
    expect(porId.pedidos).toBe('4');
    const baldes = Number(porId.pendentes) + Number(porId.atendidos) + Number(porId.cancelados) + Number(porId.outros);
    expect(baldes).toBe(4);
  });

  it('sem base de comparação, a variação diz isso em vez de inventar um percentual', () => {
    const metricas = metricasLaterais(painel([pedido({ numero: '1', status: 'Entregue', total: 40 })]), AGORA);
    const variacao = metricas.find((m) => m.rotulo === 'vs. 30d anteriores');

    // A janela anterior foi zero: não existe "+100%" honesto aqui.
    expect(variacao?.valor).toBe('sem base');
  });

  it('o ticket médio some quando não há venda ativa na janela', () => {
    const metricas = metricasLaterais(painel([pedido({ numero: '1', status: 'Cancelado' })]), AGORA);

    expect(metricas.find((m) => m.rotulo === 'Ticket médio 30d')?.valor).toBe('—');
  });
});
