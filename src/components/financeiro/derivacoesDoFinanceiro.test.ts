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

describe('a borda do período é dia civil, não vinte e quatro horas', () => {
  /**
   * `data_vencimento` é `date`: não tem hora. A versão anterior comparava
   * `agora - N × 24h` com a meia-noite da data, e às 12:00 do dia 8 o
   * vencimento do dia 1 caía fora de "7 dias" por doze horas que não existem
   * no dado. Estes casos fixam a janela nos dois lados.
   */
  function comVencimento(dia: string) {
    return [titulo({ data_vencimento: dia, descricao: dia })];
  }

  // Instantes do MESMO dia civil local (8 de setembro), da primeira à última
  // hora. "Hoje" é o dia de quem olha a tela, então a base é a data local — e
  // é justamente por isso que os três têm de dar a mesma janela.
  const dia8 = (h: number, m: number, sec: number) => new Date(2026, 8, 8, h, m, sec).getTime();
  const LOGO_CEDO = dia8(0, 0, 1);
  const MEIO_DIA = dia8(12, 0, 0);
  const QUASE_MEIA_NOITE = dia8(23, 59, 59);

  it.each([
    ['7', '2026-09-02', '2026-09-01'],
    ['30', '2026-08-10', '2026-08-09'],
    ['90', '2026-06-11', '2026-06-10'],
  ] as const)('%s dias: inclui %s e exclui %s', (periodo, primeiroIncluido, ultimoExcluido) => {
    expect(recortarPorVencimento(comVencimento(primeiroIncluido), periodo, MEIO_DIA)).toHaveLength(1);
    expect(recortarPorVencimento(comVencimento(ultimoExcluido), periodo, MEIO_DIA)).toHaveLength(0);
  });

  it('a hora em que a tela foi aberta não muda a janela', () => {
    for (const baseline of [LOGO_CEDO, MEIO_DIA, QUASE_MEIA_NOITE]) {
      expect(recortarPorVencimento(comVencimento('2026-09-02'), '7', baseline)).toHaveLength(1);
      expect(recortarPorVencimento(comVencimento('2026-09-01'), '7', baseline)).toHaveLength(0);
    }
  });

  it('a janela de N dias tem exatamente N dias, incluindo o de hoje', () => {
    const dias = ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'];
    const lista = dias.map((dia) => titulo({ data_vencimento: dia, descricao: dia }));
    expect(recortarPorVencimento(lista, '7', MEIO_DIA)).toHaveLength(7);
  });

  it('um vencimento com hora é cortado pelo dia, não pelo instante', () => {
    const lista = [titulo({ data_vencimento: '2026-09-02T00:30:00Z', descricao: 'limite' })];
    expect(recortarPorVencimento(lista, '7', MEIO_DIA)).toHaveLength(1);
  });

  it('a tabela e os dois gráficos usam exatamente o mesmo corte', () => {
    const lista = [
      titulo({ data_vencimento: '2026-09-02', valor: 10, descricao: 'dentro' }),
      titulo({ data_vencimento: '2026-09-01', valor: 99, descricao: 'fora' }),
    ];
    const naTabela = recortarPorVencimento(lista, '7', MEIO_DIA).map((t) => t.descricao);
    const nosGraficos = titulosElegiveis(lista, '7', MEIO_DIA).map((t) => t.descricao);
    expect(naTabela).toEqual(['dentro']);
    expect(nosGraficos).toEqual(['dentro']);
    expect(serieDoFluxo(titulosElegiveis(lista, '7', MEIO_DIA))).toEqual([
      { date: '2026-09-02', receitas: 10, despesas: 0 },
    ]);
  });
});

describe('a janela é retrospectiva: o futuro não entra', () => {
  /**
   * "7 dias" é hoje e os seis anteriores — uma janela de sete dias civis, e
   * não "de sete dias atrás em diante". Sem teto, um vencimento de 30/09
   * entrava em `7 dias` no dia 08/09: a contagem deixava de ter N dias e o
   * filtro deixava de ser retrospectivo, ao contrário do de Vendas.
   *
   * `all` é o histórico inteiro, e aí o futuro entra — é o que "todo o
   * período" quer dizer.
   */
  const HOJE = new Date(2026, 8, 8, 12, 0, 0).getTime();

  function so(dia: string) {
    return [titulo({ data_vencimento: dia, descricao: dia })];
  }

  it.each([
    ['7', '2026-09-02'],
    ['30', '2026-08-10'],
    ['90', '2026-06-11'],
  ] as const)('%s dias: hoje entra, o primeiro dia entra, o anterior a ele não', (periodo, primeiroDia) => {
    expect(recortarPorVencimento(so('2026-09-08'), periodo, HOJE)).toHaveLength(1);
    expect(recortarPorVencimento(so(primeiroDia), periodo, HOJE)).toHaveLength(1);

    const anterior = new Date(Date.parse(`${primeiroDia}T00:00:00Z`) - 86_400_000)
      .toISOString().slice(0, 10);
    expect(recortarPorVencimento(so(anterior), periodo, HOJE)).toHaveLength(0);
  });

  it.each(['7', '30', '90'] as const)('%s dias: amanhã não entra, e uma data bem futura também não', (periodo) => {
    expect(recortarPorVencimento(so('2026-09-09'), periodo, HOJE)).toHaveLength(0);
    expect(recortarPorVencimento(so('2026-09-30'), periodo, HOJE)).toHaveLength(0);
    expect(recortarPorVencimento(so('2027-01-01'), periodo, HOJE)).toHaveLength(0);
  });

  it('`all` continua devolvendo o histórico inteiro, futuro incluído', () => {
    const lista = [
      titulo({ data_vencimento: '2026-09-30', descricao: 'futuro' }),
      titulo({ data_vencimento: '2026-09-08', descricao: 'hoje' }),
      titulo({ data_vencimento: '2020-01-01', descricao: 'antigo' }),
    ];
    expect(recortarPorVencimento(lista, 'all', HOJE).map((t) => t.descricao))
      .toEqual(['futuro', 'hoje', 'antigo']);
  });

  it('a hora em que a tela abriu não move o teto', () => {
    for (const h of [0, 12, 23]) {
      const baseline = new Date(2026, 8, 8, h, 30, 0).getTime();
      expect(recortarPorVencimento(so('2026-09-08'), '7', baseline)).toHaveLength(1);
      expect(recortarPorVencimento(so('2026-09-09'), '7', baseline)).toHaveLength(0);
    }
  });

  it('a tabela e os dois gráficos recusam o futuro juntos', () => {
    const lista = [
      titulo({ data_vencimento: '2026-09-08', valor: 10, descricao: 'hoje' }),
      titulo({ data_vencimento: '2026-09-30', valor: 99, descricao: 'futuro' }),
    ];
    expect(recortarPorVencimento(lista, '7', HOJE).map((t) => t.descricao)).toEqual(['hoje']);
    expect(titulosElegiveis(lista, '7', HOJE).map((t) => t.descricao)).toEqual(['hoje']);
    expect(serieDoFluxo(titulosElegiveis(lista, '7', HOJE)))
      .toEqual([{ date: '2026-09-08', receitas: 10, despesas: 0 }]);
    expect(barrasDeEntradaESaida(titulosElegiveis(lista, '7', HOJE)))
      .toEqual([{ date: '2026-09-08', entradas: 10, saidas: 0 }]);
  });
});
