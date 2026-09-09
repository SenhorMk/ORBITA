import type { Periodo } from '@/components/vendas/filtrosDeVendas';
import type { TituloFinanceiro } from './useLeituraFinanceira';

/**
 * As derivações do Financeiro — puras, e **uma só fonte para os dois gráficos**.
 *
 * ## Que data governa o tempo aqui
 *
 * `data_vencimento`, e não é escolha de conveniência: é a semântica que o
 * produto já tem. A API ordena por ela (`getTitulosFiltro`), o fluxo de caixa
 * sempre agregou por ela, e o banco indexa por ela desde `06_financeiro.sql`.
 * `data_pagamento` só existe em título quitado — usá-la deixaria todo título em
 * aberto fora do eixo, que é justamente o que o fluxo de caixa precisa mostrar.
 * `created_at` é quando a linha entrou no ORBITA, um fato de sincronização, não
 * um fato financeiro.
 *
 * Nada aqui inventa competência, caixa realizado ou previsão. Não existem essas
 * duas semânticas no ORBITA, e fabricá-las seria pior do que não tê-las.
 *
 * ## O que é elegível
 *
 * `cancelado` e `estornado` ficam de fora dos gráficos pelo mesmo motivo pelo
 * qual ficam de fora dos totais: não são dinheiro que entrou nem que vai
 * entrar. Eles continuam na lista, visíveis, porque o histórico é deles também.
 */

export interface PontoDoFluxo {
  date: string;
  receitas: number;
  despesas: number;
}

/** Um dia do gráfico de barras: entradas para cima, saídas para baixo. */
export interface BarraDoDia {
  date: string;
  entradas: number;
  /** Negativo de propósito: é o que põe a barra abaixo do eixo zero. */
  saidas: number;
}

/** Só o dia, sem hora — a chave de agrupamento de tudo aqui. */
function diaDe(titulo: TituloFinanceiro): string {
  return diaCivil(titulo.data_vencimento) || titulo.data_vencimento;
}

/** `AAAA-MM-DD` de uma data que pode vir com hora, sem passar por fuso. */
function diaCivil(valor: string): string {
  return (valor ?? '').slice(0, 10);
}

/**
 * O primeiro dia civil incluído no período, a partir do dia de `baseline`.
 *
 * `7 dias` conta o dia de hoje e os seis anteriores — a janela é fechada dos
 * dois lados e tem exatamente N dias.
 */
export function primeiroDiaDoPeriodo(periodo: Exclude<Periodo, 'all'>, baseline: number): string {
  const hoje = new Date(baseline);
  // UTC de propósito: o único uso é aritmética de calendário sobre a data
  // local já extraída, e o horário de verão não pode encurtar uma janela.
  const inicio = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())
    - (Number(periodo) - 1) * 24 * 60 * 60 * 1000;
  return new Date(inicio).toISOString().slice(0, 10);
}

/**
 * O recorte de período, pelo vencimento — em **dia civil**, não em horas.
 *
 * `data_vencimento` é `date` no banco: não tem hora. A versão anterior fazia
 * `agora - N × 24h` e comparava com `new Date('2026-09-01')`, que é meia-noite:
 * às 12:00 do dia 8, o vencimento do dia 1 caía fora de "7 dias" por doze horas
 * que não existem no dado. O corte agora é entre strings `AAAA-MM-DD`, então o
 * resultado não depende da hora em que a tela foi aberta nem do fuso do
 * navegador.
 *
 * A semântica de Vendas (`recortarPorPeriodo`) não muda: lá o campo é um
 * `timestamp` de verdade, e comparar instantes é o certo.
 *
 * @param baseline - O "agora" da tela, fixado uma vez por montagem. Sem isso o
 *   corte se moveria a cada renderização e os dois gráficos poderiam discordar.
 */
export function recortarPorVencimento<T extends { data_vencimento: string }>(
  titulos: readonly T[],
  periodo: Periodo,
  baseline: number,
): T[] {
  if (periodo === 'all') return [...titulos];
  const primeiroDia = primeiroDiaDoPeriodo(periodo, baseline);
  return titulos.filter((titulo) => diaCivil(titulo.data_vencimento) >= primeiroDia);
}

/**
 * Os títulos que os **dois** gráficos enxergam.
 *
 * Existe para que não haja duas agregações discordando: as barras e as curvas
 * partem desta mesma lista, no mesmo período, com o mesmo recorte de situação.
 */
export function titulosElegiveis(
  titulos: readonly TituloFinanceiro[],
  periodo: Periodo,
  baseline: number,
): TituloFinanceiro[] {
  return recortarPorVencimento(titulos, periodo, baseline)
    .filter((t) => t.situacao === 'pago' || t.situacao === 'aberto');
}

/** Soma por dia, devolvendo os dias em ordem. */
function somarPorDia<T>(
  titulos: readonly TituloFinanceiro[],
  vazio: (date: string) => T,
  acumular: (alvo: T, titulo: TituloFinanceiro) => void,
): T[] {
  const porDia = new Map<string, T>();
  for (const titulo of titulos) {
    const date = diaDe(titulo);
    let alvo = porDia.get(date);
    if (alvo === undefined) {
      alvo = vazio(date);
      porDia.set(date, alvo);
    }
    acumular(alvo, titulo);
  }
  return [...porDia.values()].sort((a, b) =>
    (a as { date: string }).date.localeCompare((b as { date: string }).date));
}

/** A série do fluxo de caixa: entradas e saídas por dia de vencimento. */
export function serieDoFluxo(elegiveis: readonly TituloFinanceiro[]): PontoDoFluxo[] {
  return somarPorDia<PontoDoFluxo>(
    elegiveis,
    (date) => ({ date, receitas: 0, despesas: 0 }),
    (ponto, titulo) => {
      if (titulo.tipo === 'receber') ponto.receitas += titulo.valor;
      else ponto.despesas += titulo.valor;
    },
  );
}

/**
 * As barras de entradas e saídas em torno do zero.
 *
 * A saída é gravada **negativa** porque é isso que a põe abaixo do eixo. O
 * valor absoluto continua sendo o mesmo do título; o sinal é orientação, e a
 * formatação de moeda o desfaz na hora de mostrar.
 */
export function barrasDeEntradaESaida(elegiveis: readonly TituloFinanceiro[]): BarraDoDia[] {
  return somarPorDia<BarraDoDia>(
    elegiveis,
    (date) => ({ date, entradas: 0, saidas: 0 }),
    (barra, titulo) => {
      if (titulo.tipo === 'receber') barra.entradas += titulo.valor;
      else barra.saidas -= titulo.valor;
    },
  );
}
