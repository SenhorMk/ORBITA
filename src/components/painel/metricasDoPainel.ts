import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import type { DadosDoPainel } from './useLeituraDoPainel';
import {
  faturamentoNaJanela,
  pedidoContaComoVendaAtiva,
  pedidosComNfePendente,
  variacaoPercentual,
} from '@/lib/metricas/vendasAtivas';
import { aparenciaDoStatus } from '@/components/ui/StatusPill';
import { descreverOrigem } from '@/components/vendas/filtrosDeVendas';

/**
 * As métricas da Visão Geral — e o que cada uma explica quando é escolhida.
 *
 * ## Tudo sai do mesmo payload, e nada é inventado
 *
 * O endpoint do painel devolve os pedidos inteiros, com cliente e nota. Isso é
 * suficiente para uma série diária **real** e para distribuições que fecham com
 * o total. O que não existe no payload não vira gráfico: quando uma métrica só
 * tem um agregado, a área analítica mostra um resumo verdadeiro em vez de
 * desenhar uma curva que ninguém mediu.
 *
 * Faturamento e comparação usam `faturamentoNaJanela`, a **mesma** função das
 * estatísticas do servidor, avaliada aqui sobre a mesma lista. Assim o número
 * grande, a série embaixo dele e a variação ao lado não têm como divergir: são
 * uma conta só, com um relógio só.
 *
 * ## Os quatro baldes, e por que existe um quarto
 *
 * O servidor classifica os pedidos em `pendentes`, `cancelados` e `atendidos`
 * por radical do status. Esses três **não cobrem** o vocabulário real: `Novo`,
 * `Em Processamento`, `Despachado`, `Enviado`, `Entregue`, `A Emitir` e
 * `Concluído` não caem em nenhum deles — e `Entregue` é justamente o que a
 * venda manual grava. Somar os três e chamar de total daria um número que não
 * fecha.
 *
 * Por isso existe **Outros**: com ele os quatro baldes somam exatamente o total
 * de pedidos, e a tela pode dizer isso sem ressalva.
 */

export type MetricaId =
  | 'pedidos'
  | 'faturamento'
  | 'nfe'
  | 'pendentes'
  | 'atendidos'
  | 'cancelados'
  | 'outros';

export type Balde = 'pendentes' | 'atendidos' | 'cancelados' | 'outros';

/** Uma célula clicável da linha de contexto. */
export interface Celula {
  readonly id: MetricaId;
  readonly rotulo: string;
  readonly valor: string;
  readonly cor?: string;
}

/** Um número do painel lateral. Não é clicável: é contexto, não recorte. */
export interface MetricaLateral {
  readonly rotulo: string;
  readonly valor: string;
  readonly cor: string;
}

export interface FatiaDeDistribuicao {
  readonly rotulo: string;
  readonly quantidade: number;
  readonly valor: string;
  readonly cor: string;
  /** Fração do total, de 0 a 1. */
  readonly fracao: number;
}

/** O que a área analítica mostra para a métrica escolhida. */
export type Analise =
  | {
      readonly tipo: 'serie';
      readonly titulo: string;
      readonly destaque: string;
      readonly variacao: string | null;
      readonly variacaoPositiva: boolean;
      readonly pontos: ReadonlyArray<{ readonly rotulo: string; readonly valor: number }>;
      readonly comparacao: ReadonlyArray<{ readonly rotulo: string; readonly valor: string }>;
    }
  | {
      readonly tipo: 'distribuicao';
      readonly titulo: string;
      readonly destaque: string;
      readonly legenda: string;
      readonly fatias: readonly FatiaDeDistribuicao[];
    }
  | {
      readonly tipo: 'fila';
      readonly titulo: string;
      readonly destaque: string;
      readonly legenda: string;
      readonly itens: ReadonlyArray<{
        readonly numero: string;
        readonly cliente: string;
        readonly idade: string;
        readonly valor: string;
      }>;
    }
  | {
      readonly tipo: 'vazia';
      readonly titulo: string;
      readonly destaque: string;
      readonly motivo: string;
    };

const DIA_MS = 24 * 60 * 60 * 1000;
const JANELA_DIAS = 30;

export function reais(valor: number): string {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * O balde de um pedido.
 *
 * Os três primeiros repetem o critério do servidor — radical do status, e não
 * igualdade, porque o status chega de duas fontes e já apareceu em caixas
 * diferentes. `outros` é o resto, e existe para que a soma feche.
 */
export function baldeDoPedido(pedido: { status?: string | null }): Balde {
  const status = (pedido.status ?? '').toLowerCase();
  if (!pedidoContaComoVendaAtiva(pedido)) return 'cancelados';
  if (status.includes('pend') || status.includes('aberto')) return 'pendentes';
  if (status.includes('atend') || status.includes('fatur')) return 'atendidos';
  return 'outros';
}

const ROTULO_DO_BALDE: Record<Balde, string> = {
  pendentes: 'Pendentes',
  atendidos: 'Atendidos',
  cancelados: 'Cancelados',
  outros: 'Outros status',
};

/**
 * Um acento lime e um lavanda, e nada além disso — a regra de ênfase do Design
 * System. Lime é o que fechou, lavanda é o que espera; cancelado é semântico e
 * "outros" fica neutro, porque é um resto e não uma categoria com significado
 * próprio.
 */
const COR_DO_BALDE: Record<Balde, string> = {
  pendentes: 'var(--accent-2)',
  atendidos: 'var(--accent)',
  cancelados: 'var(--danger)',
  outros: 'var(--bar)',
};

export function baldesDosPedidos(pedidos: readonly PedidoEnriquecido[]): Record<Balde, PedidoEnriquecido[]> {
  const baldes: Record<Balde, PedidoEnriquecido[]> = {
    pendentes: [],
    atendidos: [],
    cancelados: [],
    outros: [],
  };
  for (const pedido of pedidos) baldes[baldeDoPedido(pedido)].push(pedido);
  return baldes;
}

export function somarPedidos(pedidos: readonly PedidoEnriquecido[]): number {
  return pedidos.reduce((total, pedido) => {
    const valor = Number(pedido.total ?? 0);
    return total + (Number.isFinite(valor) ? valor : 0);
  }, 0);
}

/**
 * O faturamento de cada um dos últimos 30 dias.
 *
 * Cada ponto é a soma dos pedidos **ativos** daquele dia — não é um agregado
 * repartido, é a leitura de cada pedido na data dele. Por isso a soma dos
 * pontos é exatamente o faturamento da janela.
 */
export function serieDiariaDeFaturamento(
  pedidos: readonly PedidoEnriquecido[],
  agora: number,
): Array<{ rotulo: string; valor: number }> {
  const inicio = new Date(agora - JANELA_DIAS * DIA_MS);
  inicio.setHours(0, 0, 0, 0);

  const porDia = new Map<string, number>();
  for (let i = 0; i <= JANELA_DIAS; i += 1) {
    const dia = new Date(inicio.getTime() + i * DIA_MS);
    porDia.set(dia.toDateString(), 0);
  }

  for (const pedido of pedidos) {
    if (!pedidoContaComoVendaAtiva(pedido)) continue;
    const quando = new Date(pedido.data ?? '');
    if (!Number.isFinite(quando.getTime())) continue;
    const chave = quando.toDateString();
    if (!porDia.has(chave)) continue;
    const valor = Number(pedido.total ?? 0);
    porDia.set(chave, (porDia.get(chave) ?? 0) + (Number.isFinite(valor) ? valor : 0));
  }

  return [...porDia.entries()].map(([chave, valor]) => ({
    rotulo: new Date(chave).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
    valor,
  }));
}

/** A distribuição por status real. Fecha com o total: nenhum pedido fica de fora. */
export function distribuicaoPorStatus(pedidos: readonly PedidoEnriquecido[]): FatiaDeDistribuicao[] {
  const porStatus = new Map<string, PedidoEnriquecido[]>();
  for (const pedido of pedidos) {
    const { rotulo } = aparenciaDoStatus(pedido.status);
    const lista = porStatus.get(rotulo) ?? [];
    lista.push(pedido);
    porStatus.set(rotulo, lista);
  }

  const total = pedidos.length || 1;
  return [...porStatus.entries()]
    .map(([rotulo, lista]) => ({
      rotulo,
      quantidade: lista.length,
      valor: reais(somarPedidos(lista)),
      cor: aparenciaDoStatus(lista[0].status).cor,
      fracao: lista.length / total,
    }))
    .sort((a, b) => b.quantidade - a.quantidade);
}

/** A distribuição por origem: de onde o pedido entrou no Orbita. Não é canal. */
export function distribuicaoPorOrigem(pedidos: readonly PedidoEnriquecido[]): FatiaDeDistribuicao[] {
  const porOrigem = new Map<string, PedidoEnriquecido[]>();
  for (const pedido of pedidos) {
    const rotulo = descreverOrigem(pedido.origem);
    const lista = porOrigem.get(rotulo) ?? [];
    lista.push(pedido);
    porOrigem.set(rotulo, lista);
  }

  const total = pedidos.length || 1;
  const cores = ['var(--accent)', 'var(--accent-2)', 'var(--info)', 'var(--txt2)'];
  return [...porOrigem.entries()]
    .map(([rotulo, lista], indice) => ({
      rotulo,
      quantidade: lista.length,
      valor: reais(somarPedidos(lista)),
      cor: cores[indice % cores.length],
      fracao: lista.length / total,
    }))
    .sort((a, b) => b.quantidade - a.quantidade);
}

/** As sete células de contexto. Todas clicáveis, todas somando o que dizem somar. */
export function celulasDoPainel(dados: DadosDoPainel, agora: number): Celula[] {
  const baldes = baldesDosPedidos(dados.pedidos);
  const fim = new Date(agora);
  const inicio = new Date(agora - JANELA_DIAS * DIA_MS);

  return [
    { id: 'pedidos', rotulo: 'Pedidos', valor: String(dados.pedidos.length) },
    {
      id: 'faturamento',
      rotulo: 'Faturamento 30d',
      valor: reais(faturamentoNaJanela(dados.pedidos, inicio, fim)),
    },
    {
      id: 'nfe',
      rotulo: 'A emitir NF-e',
      valor: String(pedidosComNfePendente(dados.pedidos).length),
      cor: 'var(--warning)',
    },
    { id: 'pendentes', rotulo: 'Pendentes', valor: String(baldes.pendentes.length) },
    { id: 'atendidos', rotulo: 'Atendidos', valor: String(baldes.atendidos.length) },
    {
      id: 'cancelados',
      rotulo: 'Cancelados',
      valor: String(baldes.cancelados.length),
      cor: 'var(--danger)',
    },
    { id: 'outros', rotulo: 'Outros status', valor: String(baldes.outros.length) },
  ];
}

/** O anel: a repartição dos pedidos por balde, e o total no centro. */
export function anelDePedidos(pedidos: readonly PedidoEnriquecido[]): {
  total: number;
  fatias: FatiaDeDistribuicao[];
} {
  const baldes = baldesDosPedidos(pedidos);
  const total = pedidos.length;
  const ordem: Balde[] = ['atendidos', 'outros', 'pendentes', 'cancelados'];

  return {
    total,
    fatias: ordem
      .filter((balde) => baldes[balde].length > 0)
      .map((balde) => ({
        rotulo: ROTULO_DO_BALDE[balde],
        quantidade: baldes[balde].length,
        valor: reais(somarPedidos(baldes[balde])),
        cor: COR_DO_BALDE[balde],
        fracao: total === 0 ? 0 : baldes[balde].length / total,
      })),
  };
}

/** Os seis números de contexto do painel lateral. */
export function metricasLaterais(dados: DadosDoPainel, agora: number): MetricaLateral[] {
  const fim = new Date(agora);
  const inicio = new Date(agora - JANELA_DIAS * DIA_MS);
  const anterior = new Date(agora - 2 * JANELA_DIAS * DIA_MS);

  const faturamento = faturamentoNaJanela(dados.pedidos, inicio, fim);
  const faturamentoAnterior = faturamentoNaJanela(dados.pedidos, anterior, inicio);
  const variacao = variacaoPercentual(faturamento, faturamentoAnterior);

  const ativosNaJanela = dados.pedidos.filter((pedido) => {
    if (!pedidoContaComoVendaAtiva(pedido)) return false;
    const quando = new Date(pedido.data ?? '').getTime();
    return Number.isFinite(quando) && quando >= inicio.getTime() && quando < fim.getTime();
  });

  return [
    { rotulo: 'Faturamento 30d', valor: reais(faturamento), cor: 'var(--accent)' },
    {
      rotulo: 'vs. 30d anteriores',
      // `null` quando a janela anterior foi zero: não há base de comparação, e
      // inventar "+100%" seria pior que dizer que não dá para comparar.
      valor: variacao === null ? 'sem base' : `${variacao > 0 ? '+' : ''}${variacao.toFixed(1)}%`,
      cor: variacao === null ? 'var(--txt3)' : variacao >= 0 ? 'var(--accent)' : 'var(--danger)',
    },
    {
      rotulo: 'Ticket médio 30d',
      valor: ativosNaJanela.length === 0 ? '—' : reais(faturamento / ativosNaJanela.length),
      cor: 'var(--txt)',
    },
    { rotulo: 'Vendas ativas 30d', valor: String(ativosNaJanela.length), cor: 'var(--info)' },
    { rotulo: 'Produtos', valor: String(dados.produtos.length), cor: 'var(--txt2)' },
    { rotulo: 'Clientes', valor: String(dados.clientes.length), cor: 'var(--txt2)' },
  ];
}
