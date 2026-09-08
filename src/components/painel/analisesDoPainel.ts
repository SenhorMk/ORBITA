import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import type { DadosDoPainel } from './useLeituraDoPainel';
import { faturamentoNaJanela, pedidosComNfePendente, variacaoPercentual } from '@/lib/metricas/vendasAtivas';
import { idadeDeIso } from '@/lib/tempoRelativo';
import {
  baldesDosPedidos,
  distribuicaoPorOrigem,
  distribuicaoPorStatus,
  reais,
  serieDiariaDeFaturamento,
  somarPedidos,
  type Analise,
  type MetricaId,
} from './metricasDoPainel';

/**
 * O que a área analítica mostra para cada métrica.
 *
 * A regra que atravessa este arquivo inteiro: **só entra o que o payload já
 * tem**. Onde há medida por dia, há série; onde há repartição verdadeira de um
 * total, há distribuição; onde o que importa é a espera, há fila. Onde não há
 * nada disso, a área diz que não há — em vez de desenhar uma curva que ninguém
 * mediu.
 */

const DIA_MS = 24 * 60 * 60 * 1000;
const JANELA_DIAS = 30;

function analiseDeBalde(
  pedidos: readonly PedidoEnriquecido[],
  titulo: string,
  legenda: string,
): Analise {
  if (pedidos.length === 0) {
    return {
      tipo: 'vazia',
      titulo,
      destaque: '0',
      motivo: 'Nenhum pedido neste recorte — não há o que repartir.',
    };
  }
  return {
    tipo: 'distribuicao',
    titulo,
    destaque: String(pedidos.length),
    legenda: `${legenda} · ${reais(somarPedidos(pedidos))} no total`,
    fatias: distribuicaoPorOrigem(pedidos),
  };
}

/**
 * A análise da métrica escolhida.
 *
 * Cada ramo usa só o que o payload já tem. Onde não há série medida, não há
 * curva: há a repartição verdadeira, ou a fila, ou a frase que diz que não há
 * o que mostrar.
 */
export function analiseDaMetrica(
  metrica: MetricaId,
  dados: DadosDoPainel,
  agora: number,
): Analise {
  const baldes = baldesDosPedidos(dados.pedidos);

  if (metrica === 'faturamento') {
    const fim = new Date(agora);
    const inicio = new Date(agora - JANELA_DIAS * DIA_MS);
    const anterior = new Date(agora - 2 * JANELA_DIAS * DIA_MS);
    const atual = faturamentoNaJanela(dados.pedidos, inicio, fim);
    const passado = faturamentoNaJanela(dados.pedidos, anterior, inicio);
    const variacao = variacaoPercentual(atual, passado);
    const pontos = serieDiariaDeFaturamento(dados.pedidos, agora);

    if (atual === 0 && passado === 0) {
      return {
        tipo: 'vazia',
        titulo: 'Faturamento · últimos 30 dias',
        destaque: reais(0),
        motivo: 'Nenhuma venda ativa nos últimos 60 dias. Sem faturamento medido, não há série para desenhar.',
      };
    }

    return {
      tipo: 'serie',
      titulo: 'Faturamento · últimos 30 dias',
      destaque: reais(atual),
      variacao: variacao === null ? null : `${variacao > 0 ? '+' : ''}${variacao.toFixed(1)}% vs. 30d anteriores`,
      variacaoPositiva: (variacao ?? 0) >= 0,
      pontos,
      comparacao: [
        { rotulo: 'Últimos 30 dias', valor: reais(atual) },
        { rotulo: '30 dias anteriores', valor: passado === 0 ? 'sem base' : reais(passado) },
      ],
    };
  }

  if (metrica === 'pedidos') {
    if (dados.pedidos.length === 0) {
      return {
        tipo: 'vazia',
        titulo: 'Pedidos · por status',
        destaque: '0',
        motivo: 'Nenhum pedido nesta organização ainda.',
      };
    }
    return {
      tipo: 'distribuicao',
      titulo: 'Pedidos · por status',
      destaque: String(dados.pedidos.length),
      legenda: 'Todos os pedidos, pelo status atual de cada um',
      fatias: distribuicaoPorStatus(dados.pedidos),
    };
  }

  if (metrica === 'nfe') {
    const fila = pedidosComNfePendente(dados.pedidos)
      .slice()
      .sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());

    if (fila.length === 0) {
      return {
        tipo: 'vazia',
        titulo: 'A emitir NF-e',
        destaque: '0',
        motivo: 'Nenhum pedido ativo esperando nota fiscal.',
      };
    }

    return {
      tipo: 'fila',
      titulo: 'A emitir NF-e · dos mais antigos',
      destaque: String(fila.length),
      legenda: `${reais(somarPedidos(fila))} esperando emissão`,
      itens: fila.slice(0, 6).map((pedido) => ({
        numero: `#${pedido.numero}`,
        cliente: pedido.cliente?.nome ?? 'Cliente Consumidor',
        idade: idadeDeIso(pedido.data, agora) ?? '—',
        valor: reais(Number(pedido.total ?? 0)),
      })),
    };
  }

  if (metrica === 'pendentes') {
    return analiseDeBalde(baldes.pendentes, 'Pendentes · por origem', 'Pedidos pendentes ou abertos');
  }
  if (metrica === 'atendidos') {
    return analiseDeBalde(baldes.atendidos, 'Atendidos · por origem', 'Pedidos atendidos ou faturados');
  }
  if (metrica === 'cancelados') {
    return analiseDeBalde(baldes.cancelados, 'Cancelados · por origem', 'Pedidos cancelados, fora das métricas de venda');
  }

  return analiseDeBalde(
    baldes.outros,
    'Outros status · por origem',
    'Pedidos que não caem em pendente, atendido nem cancelado',
  );
}
