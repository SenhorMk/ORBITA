import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { pedidoContaComoVendaAtiva, pedidosComNfePendente } from '@/lib/metricas/vendasAtivas';

/**
 * As regras dos chips de resumo de Vendas & Pedidos.
 *
 * ## Por que isto é um módulo próprio, e sem React
 *
 * Um chip afirma um número sobre a operação. Se a regra dele mora dentro do
 * JSX, ela só pode ser conferida olhando a tela — e foi assim que o painel
 * chegou a mostrar "3 pedidos a emitir NF-e" com um deles cancelado. A regra
 * fica aqui, sozinha e testável, e a tela apenas desenha o que ela devolve.
 *
 * ## O mockup não define semântica
 *
 * `Orbita Vendas.dc.html` mostra cinco chips: "A emitir NF-e", "Em separação",
 * "Em trânsito", "Conflito Bling" e "Aguardando pgto". Três desses nomes não
 * correspondem a nada que o contrato atual saiba dizer:
 *
 * - **Em separação** não existe. O vocabulário real de status é o da migração
 *   `03_update_pedidos_status.sql` — `Novo`, `Aberto`, `Em Processamento`,
 *   `Despachado`, `Enviado`, `Entregue`, `Pendente`, `A Emitir`, `Atendido`,
 *   `Cancelado`, `Concluído` — e nenhum deles significa separação.
 *   `Em Processamento` é o mais próximo, e "processando" não é "separando".
 *   Omitido.
 * - **Em trânsito** seria `Despachado` ou `Enviado` renomeado, e não dá para
 *   saber qual: os dois existem, significam coisas diferentes, e "em trânsito"
 *   promete um rastreamento que este contrato não tem. Omitido.
 * - **Aguardando pgto** seria `Pendente` renomeado. `Pendente` é um estado
 *   real, e entra com esse nome — o que não entra é a promessa sobre pagamento
 *   que o rótulo do mockup faz e o dado não sustenta.
 *
 * Ficam, então, quatro status verdadeiros e a atenção operacional:
 *
 * - **Entregue** — pedidos cujo status **é agora** `Entregue`. Nada além disso:
 *   a venda manual nasce com esse status, mas depois converge para o que vier
 *   do Bling, e já houve venda manual real terminando como `Pendente`. Dizer
 *   que "Entregue é o status das vendas manuais" seria transformar um estado
 *   inicial em regra permanente.
 * - **Pendente** — pedidos cujo status **é agora** `Pendente`. É o estado em
 *   que uma venda espera resolução, e é onde vendas manuais reais já
 *   terminaram.
 * - **Cancelado** — a única forma de o resumo dizer quanto do histórico já não
 *   é operação, sem tirar esses pedidos da lista.
 *
 * Quatro chips verdadeiros valem mais que cinco falsos.
 */

/** Um chip é ou um status real, ou uma fila que o código já sabe calcular. */
export type TipoDeChip =
  /** Filtro determinístico sobre um status que existe no contrato. */
  | 'status'
  /** Fila derivada de uma regra que já existe no código. */
  | 'fila-operacional'
  /** Atenção operacional que não é sobre a lista de pedidos. */
  | 'atencao';

export interface ChipDeResumo {
  readonly id: string;
  readonly rotulo: string;
  readonly tipo: TipoDeChip;
  readonly quantidade: number;
  /** Soma em reais, ou `null` quando o contrato não conhece o valor. */
  readonly soma: number | null;
  readonly cor: string;
  /** Se clicar nele filtra a tabela de pedidos. */
  readonly filtraTabela: boolean;
  /** O que ele responde, em uma frase — vai para o `title`. */
  readonly explicacao: string;
}

/** Os chips que filtram a tabela, e o predicado de cada um. */
const CHIPS_DE_PEDIDO = ['a-emitir-nfe', 'pendente', 'entregue', 'cancelado'] as const;
export type ChipDePedido = (typeof CHIPS_DE_PEDIDO)[number];

export function ehChipDePedido(id: string | null): id is ChipDePedido {
  return id !== null && (CHIPS_DE_PEDIDO as readonly string[]).includes(id);
}

/**
 * Os pedidos de um chip, dentro de uma base já recortada por período.
 *
 * É a **mesma** função que conta e que filtra: um chip não tem como dizer "3" e
 * abrir uma tabela com 4 linhas, porque não existem dois lugares onde a regra
 * possa divergir.
 *
 * `a-emitir-nfe` delega inteiramente a `pedidosComNfePendente` — o critério de
 * emissão continua sendo dele. Não é uma tradução de `pedido.status`: existe o
 * texto `A Emitir` entre os status possíveis, mas a fila também inclui pedido
 * ativo sem nota, e tratá-los como equivalentes seria inventar uma regra nova.
 */
export function pedidosDoChip(
  pedidos: readonly PedidoEnriquecido[],
  chip: ChipDePedido,
): PedidoEnriquecido[] {
  if (chip === 'a-emitir-nfe') return pedidosComNfePendente(pedidos);
  if (chip === 'cancelado') return pedidos.filter((p) => !pedidoContaComoVendaAtiva(p));
  if (chip === 'pendente') return pedidos.filter((p) => p.status === 'Pendente');
  return pedidos.filter((p) => p.status === 'Entregue');
}

function somar(pedidos: readonly PedidoEnriquecido[]): number {
  return pedidos.reduce((total, pedido) => {
    const valor = Number(pedido.total ?? 0);
    return total + (Number.isFinite(valor) ? valor : 0);
  }, 0);
}

/**
 * Os chips de resumo.
 *
 * @param pedidosDoPeriodo - A base estável: os pedidos já recortados pelo
 *   período corrente e **nada mais**. A busca textual não entra aqui de
 *   propósito — se ela reescrevesse os totais, digitar no campo mudaria a
 *   resposta de "quantos pedidos aguardam NF-e?", que é uma pergunta sobre a
 *   operação, não sobre o que está escrito na caixa de busca. O chip
 *   selecionado também não entra: os números não podem mudar por causa do
 *   próprio clique.
 * @param pendenciasDeVendaManual - Quantas tentativas de venda manual estão sem
 *   desfecho confirmado para a organização ativa.
 */
export function calcularChips(
  pedidosDoPeriodo: readonly PedidoEnriquecido[],
  pendenciasDeVendaManual: number,
): ChipDeResumo[] {
  const naFilaDeNfe = pedidosDoChip(pedidosDoPeriodo, 'a-emitir-nfe');
  const pendentes = pedidosDoChip(pedidosDoPeriodo, 'pendente');
  const entregues = pedidosDoChip(pedidosDoPeriodo, 'entregue');
  const cancelados = pedidosDoChip(pedidosDoPeriodo, 'cancelado');

  return [
    {
      id: 'a-emitir-nfe',
      rotulo: 'A emitir NF-e',
      tipo: 'fila-operacional',
      quantidade: naFilaDeNfe.length,
      soma: somar(naFilaDeNfe),
      cor: 'var(--warning)',
      filtraTabela: true,
      explicacao: 'Pedidos ativos que ainda não têm nota fiscal emitida.',
    },
    {
      id: 'pendente',
      rotulo: 'Pendente',
      tipo: 'status',
      quantidade: pendentes.length,
      soma: somar(pendentes),
      cor: 'var(--txt2)',
      filtraTabela: true,
      explicacao: 'Pedidos cujo status é, agora, Pendente.',
    },
    {
      id: 'entregue',
      rotulo: 'Entregue',
      tipo: 'status',
      quantidade: entregues.length,
      soma: somar(entregues),
      cor: 'var(--accent)',
      filtraTabela: true,
      explicacao: 'Pedidos cujo status é, agora, Entregue.',
    },
    {
      id: 'cancelado',
      rotulo: 'Cancelado',
      tipo: 'status',
      quantidade: cancelados.length,
      soma: somar(cancelados),
      cor: 'var(--danger)',
      filtraTabela: true,
      explicacao: 'Pedidos cancelados. Continuam no histórico e continuam abríveis.',
    },
    {
      id: 'conflito-bling',
      rotulo: 'Conflito Bling',
      tipo: 'atencao',
      quantidade: pendenciasDeVendaManual,
      /*
       * Sem soma, e não por esquecimento: uma tentativa pendente guarda apenas
       * a referência e o fingerprint da intenção (`TentativaPendente`). O valor
       * da venda não é conhecido por este contrato, e "R$ 0,00" ao lado de uma
       * pendência seria um número inventado onde ele mais custa caro.
       */
      soma: null,
      cor: 'var(--danger)',
      /*
       * NÃO filtra a tabela. Uma tentativa ambígua pode existir sem pedido
       * local nenhum — é exatamente o caso em que não se sabe se o pedido foi
       * criado. Filtrar a lista por ela devolveria uma tabela vazia e daria a
       * impressão de que não há o que resolver. O clique leva ao bloco de
       * pendências, que é onde a resolução acontece.
       */
      filtraTabela: false,
      explicacao: 'Vendas manuais cujo resultado no Bling não foi confirmado.',
    },
  ];
}
