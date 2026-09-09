import { describe, expect, it } from 'vitest';

import {
  barrasDeEntradaESaida,
  recortarPorVencimento,
  serieDoFluxo,
  titulosElegiveis,
} from './derivacoesDoFinanceiro';
import type { TituloFinanceiro } from './useLeituraFinanceira';

/**
 * O período e os dois gráficos.
 *
 * O que estes casos protegem: que o recorte temporal seja pelo **vencimento** —
 * a semântica que a API, o banco e o fluxo de caixa já usavam —, e que as
 * barras e as curvas partam do **mesmo** conjunto elegível. Duas agregações que
 * podem discordar sobre o mesmo período seriam dois números diferentes para o
 * mesmo mês na mesma tela.
 */

/** 2026-09-08T12:00:00Z — o "agora" fixo de todos os casos abaixo. */
const AGORA = Date.parse('2026-09-08T12:00:00.000Z');

function titulo(over: Partial<TituloFinanceiro> & { data_vencimento: string }): TituloFinanceiro {
  return {
    id: over.data_vencimento + (over.descricao ?? ''),
    bling_id: 0,
    tipo: 'receber',
    situacao: 'pago',
    valor: 100,
    descricao: 'X',
    ...over,
  };
}

const TITULOS: readonly TituloFinanceiro[] = [
  titulo({ data_vencimento: '2026-09-06', valor: 40, tipo: 'receber', descricao: 'ontem-ish' }),
  titulo({ data_vencimento: '2026-09-06', valor: 10, tipo: 'pagar', descricao: 'saida-recente' }),
  titulo({ data_vencimento: '2026-08-20', valor: 60, tipo: 'receber', descricao: 'ha-19-dias' }),
  titulo({ data_vencimento: '2026-06-01', valor: 70, tipo: 'pagar', descricao: 'ha-99-dias' }),
  titulo({ data_vencimento: '2026-09-05', valor: 500, tipo: 'receber', situacao: 'estornado', descricao: 'terminal' }),
  titulo({ data_vencimento: '2026-09-05', valor: 900, tipo: 'pagar', situacao: 'cancelado', descricao: 'terminal-saida' }),
];

describe('recorte por período', () => {
  it('corta pelo vencimento, e não por outra data', () => {
    const em7 = recortarPorVencimento(TITULOS, '7', AGORA).map((t) => t.descricao);
    expect(em7).toEqual(['ontem-ish', 'saida-recente', 'terminal', 'terminal-saida']);
  });

  it('30 dias alcança o de 19 dias atrás e deixa de fora o de 99', () => {
    const em30 = recortarPorVencimento(TITULOS, '30', AGORA).map((t) => t.descricao);
    expect(em30).toContain('ha-19-dias');
    expect(em30).not.toContain('ha-99-dias');
  });

  it('todo o período não corta nada', () => {
    expect(recortarPorVencimento(TITULOS, 'all', AGORA)).toHaveLength(TITULOS.length);
  });

  it('o recorte mantém os terminais — eles saem dos gráficos, não do histórico', () => {
    const em7 = recortarPorVencimento(TITULOS, '7', AGORA);
    expect(em7.some((t) => t.situacao === 'estornado')).toBe(true);
    expect(em7.some((t) => t.situacao === 'cancelado')).toBe(true);
  });
});

describe('o que os dois gráficos enxergam', () => {
  it('elegível é o que está no período E não é terminal', () => {
    const elegiveis = titulosElegiveis(TITULOS, '7', AGORA).map((t) => t.descricao);
    expect(elegiveis).toEqual(['ontem-ish', 'saida-recente']);
  });

  it('as barras e as curvas cobrem exatamente os mesmos dias e os mesmos totais', () => {
    for (const periodo of ['all', '7', '30', '90'] as const) {
      const elegiveis = titulosElegiveis(TITULOS, periodo, AGORA);
      const serie = serieDoFluxo(elegiveis);
      const barras = barrasDeEntradaESaida(elegiveis);

      expect(barras.map((b) => b.date)).toEqual(serie.map((p) => p.date));
      expect(barras.map((b) => b.entradas)).toEqual(serie.map((p) => p.receitas));
      // A saída é gravada negativa nas barras — é o sinal que a põe abaixo do
      // eixo zero. O módulo é o mesmo número da curva.
      expect(barras.map((b) => Math.abs(b.saidas))).toEqual(serie.map((p) => p.despesas));
    }
  });

  it('nenhum terminal entra no fluxo, mesmo quando é o maior valor do dia', () => {
    const elegiveis = titulosElegiveis(TITULOS, 'all', AGORA);
    const serie = serieDoFluxo(elegiveis);
    // 2026-09-05 só tem títulos terminais: o dia não existe no gráfico.
    expect(serie.some((p) => p.date === '2026-09-05')).toBe(false);
    expect(serie.reduce((soma, p) => soma + p.receitas, 0)).toBe(100);
  });

  it('os dias saem em ordem cronológica, e o mesmo dia é somado uma vez só', () => {
    const serie = serieDoFluxo(titulosElegiveis(TITULOS, 'all', AGORA));
    expect(serie.map((p) => p.date)).toEqual(['2026-06-01', '2026-08-20', '2026-09-06']);
    expect(serie[2]).toEqual({ date: '2026-09-06', receitas: 40, despesas: 10 });
  });

  it('um vencimento com hora é agrupado pelo dia, não por instante', () => {
    const comHora = [
      titulo({ data_vencimento: '2026-09-06T03:00:00Z', valor: 5 }),
      titulo({ data_vencimento: '2026-09-06T21:00:00Z', valor: 7, descricao: 'outro' }),
    ];
    expect(serieDoFluxo(titulosElegiveis(comHora, 'all', AGORA))).toEqual([
      { date: '2026-09-06', receitas: 12, despesas: 0 },
    ]);
  });
});
