/**
 * A regra de negócio que decide o que é VENDA ATIVA — e, por consequência, o
 * que entra em faturamento, lucro, NF-e a emitir e gráficos de receita.
 *
 * ## Por que isto existe
 *
 * Medido no staging em 07/09/2026, com três pedidos de R$ 40 (um cancelado e
 * duas vendas manuais válidas), o painel mostrava R$ 120 de faturamento,
 * R$ 50,40 de lucro e "3 pedidos a emitir NF-e". O pedido cancelado inflava
 * tudo, porque cada card somava `pedidos` por conta própria e nenhum deles
 * perguntava se aquele pedido ainda era uma venda.
 *
 * A correção não é espalhar `status !== 'Cancelado'` por cada card — é ter um
 * lugar só que responde "isto conta como venda?". O servidor (as estatísticas
 * do painel) e a tela (gráficos e listas derivadas) importam a MESMA função,
 * então não há como um card divergir do outro sem que este arquivo mude.
 *
 * ## O que um pedido cancelado continua sendo
 *
 * Histórico. Ele permanece listado, consultável e auditável — some apenas das
 * métricas que representam operação ativa. Cancelar uma venda não apaga o fato
 * de que ela existiu; só significa que ela não é receita.
 */

/** O status que o ORBITA grava para pedido cancelado, aqui e no Bling. */
export const STATUS_PEDIDO_CANCELADO = 'Cancelado';

/** O mínimo que uma métrica precisa saber sobre um pedido. */
export interface PedidoParaMetrica {
  readonly status?: string | null;
  readonly total?: number | string | null;
  readonly data?: string | null;
  readonly nfe?: unknown;
}

/**
 * O pedido conta como venda ativa?
 *
 * A comparação é frouxa de propósito (minúsculas, sem acento implícito no
 * radical "cancel"): o status chega de duas fontes — o `mapBlingStatus` do
 * webhook e a venda manual — e já apareceu como `Cancelado` e `cancelado`.
 * Uma comparação estrita deixaria a variação passar direto pela métrica, que é
 * exatamente o defeito que este módulo fecha.
 */
export function pedidoContaComoVendaAtiva(pedido: PedidoParaMetrica): boolean {
  return !(pedido.status ?? '').toLowerCase().includes('cancel');
}

/** Só os pedidos que representam venda ativa. Nunca altera a lista original. */
export function apenasVendasAtivas<T extends PedidoParaMetrica>(pedidos: readonly T[]): T[] {
  return pedidos.filter((pedido) => pedidoContaComoVendaAtiva(pedido));
}

function valorDoPedido(pedido: PedidoParaMetrica): number {
  const valor = Number(pedido.total ?? 0);
  return Number.isFinite(valor) ? valor : 0;
}

/**
 * Faturamento de uma janela: soma dos pedidos ATIVOS cuja data cai em
 * `[inicio, fim)`.
 *
 * A janela é meio-aberta para que duas janelas consecutivas — os últimos 30
 * dias e os 30 anteriores — nunca contem o mesmo pedido duas vezes, que é o
 * que permite comparar uma com a outra honestamente.
 */
export function faturamentoNaJanela(
  pedidos: readonly PedidoParaMetrica[],
  inicio: Date,
  fim: Date,
): number {
  const de = inicio.getTime();
  const ate = fim.getTime();

  return pedidos.reduce((soma, pedido) => {
    if (!pedidoContaComoVendaAtiva(pedido)) return soma;
    const quando = new Date(pedido.data ?? '').getTime();
    if (!Number.isFinite(quando) || quando < de || quando >= ate) return soma;
    return soma + valorDoPedido(pedido);
  }, 0);
}

/**
 * Os pedidos que ainda precisam de NF-e.
 *
 * O critério de emissão é o que já existia — `status === 'A Emitir'` ou pedido
 * sem nota — e continua sendo dele a última palavra. A única coisa corrigida é
 * o cancelado, que entrava por não ter nota: um pedido cancelado nunca vai
 * receber NF-e, então contá-lo como pendência é inventar trabalho.
 */
export function pedidosComNfePendente<T extends PedidoParaMetrica>(pedidos: readonly T[]): T[] {
  return apenasVendasAtivas(pedidos).filter((pedido) => pedido.status === 'A Emitir' || !pedido.nfe);
}

/**
 * Variação percentual entre duas janelas de faturamento.
 *
 * `null` quando não há base de comparação — a janela anterior foi zero. O
 * painel mostrava "+X% vs mês anterior" calculado sobre um valor fixo de
 * R$ 12.500 escrito no código; um número inventado ao lado de um número real
 * contamina os dois, porque quem lê não sabe qual é qual.
 */
export function variacaoPercentual(atual: number, anterior: number): number | null {
  if (anterior <= 0) return null;
  return ((atual - anterior) / anterior) * 100;
}
