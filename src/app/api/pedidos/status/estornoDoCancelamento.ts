import { classificarFalhaDeCriacaoNoBling } from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import { mapBlingStatus } from '@/lib/utils';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { registrarFalhaInterna, semExcecao } from './falhaDoStatus';
import type {
  PedidoStatusBlingPort,
  PedidoStatusDependencies,
  PedidoStatusPedido,
  PedidoStatusStorePort,
} from './ports';

/** Registro de um evento comercial da mudança de situação. */
export type Evento = (acao: string, metadata: Readonly<Record<string, string | number | boolean | null>>) => Promise<void>;

/**
 * O que se sabe do estorno de estoque do cancelamento.
 * - `estornado`: o Bling aceitou E o saldo relido é, produto a produto, o saldo de antes + a quantidade vendida.
 * - `divergente`: o Bling aceitou, mas o saldo relido não é o esperado. Aceite não é prova de estorno.
 * - `sem_conferencia`: o Bling aceitou, mas não houve base para conferir (itens, produto sem id no Bling,
 *   saldo de antes ou de depois ilegível). Não se declara estorno feito.
 * - `recusado`: recusa comprovada (`classificarFalhaDeCriacaoNoBling` = Definitiva). NÃO se presume o motivo:
 *   um 400 não prova "pedido sem estoque lançado".
 * - `desconhecido`: timeout, rede, 429, 5xx, resposta ilegível: o estorno pode ter sido aplicado. Sem retry.
 * - `ja_cancelado`: o pedido já estava cancelado no ORBITA antes desta requisição; repetir o estorno o dobraria.
 *
 * Saldos locais e remotos coincidindo NUNCA promovem um desfecho a `estornado`: os dois podem estar
 * igualmente errados (Bling e ORBITA em 7 não provam que a unidade voltou).
 */
type DesfechoDoEstorno =
  | 'nao_aplicavel' | 'ja_cancelado' | 'estornado' | 'divergente' | 'sem_conferencia' | 'recusado' | 'desconhecido';

/** Saldo esperado no Bling por id de produto do Bling, depois de um estorno integral. */
type SaldoEsperado = ReadonlyMap<string, number>;

/**
 * Lê, ANTES do estorno, o saldo do Bling dos produtos do pedido e soma a quantidade vendida.
 * `null` = sem base para conferir; qualquer falha aqui só tira a conferência, nunca o cancelamento.
 */
async function lerSaldoEsperado(
  scope: VerifiedOrganizationScope,
  store: PedidoStatusStorePort,
  bling: PedidoStatusBlingPort,
  pedidoId: string,
): Promise<SaldoEsperado | null> {
  try {
    const itens = await store.findItensDoPedido(scope, pedidoId);
    if (itens.length === 0) return null;
    const quantidadePorProduto = new Map<string, number>();
    for (const item of itens) {
      if (!Number.isSafeInteger(item.quantidade) || item.quantidade <= 0) return null;
      quantidadePorProduto.set(item.produtoId, (quantidadePorProduto.get(item.produtoId) ?? 0) + item.quantidade);
    }
    const produtos = await store.findProdutosByIds(scope, [...quantidadePorProduto.keys()]);
    const blingIdPorProduto = new Map<string, string>();
    for (const produto of produtos) {
      if (!produto.blingId) return null;
      blingIdPorProduto.set(produto.id, produto.blingId);
    }
    if (blingIdPorProduto.size !== quantidadePorProduto.size) return null;
    const antes = await bling.getSaldos([...blingIdPorProduto.values()]);
    const esperado = new Map<string, number>();
    for (const [produtoId, blingId] of blingIdPorProduto) {
      const saldo = antes.get(blingId);
      if (saldo === undefined) return null;
      esperado.set(blingId, (esperado.get(blingId) ?? saldo) + (quantidadePorProduto.get(produtoId) ?? 0));
    }
    return esperado;
  } catch (err: unknown) {
    registrarFalhaInterna(err, scope.organizationId);
    return null;
  }
}

/** Confronta o saldo relido com o esperado. Devolve quantos produtos divergem, ou `null` sem leitura. */
async function contarDivergencias(
  scope: VerifiedOrganizationScope,
  bling: PedidoStatusBlingPort,
  esperado: SaldoEsperado,
): Promise<number | null> {
  try {
    const depois = await bling.getSaldos([...esperado.keys()]);
    let divergentes = 0;
    for (const [blingId, saldoEsperado] of esperado) {
      if (depois.get(blingId) !== saldoEsperado) divergentes += 1;
    }
    return divergentes;
  } catch (err: unknown) {
    registrarFalhaInterna(err, scope.organizationId);
    return null;
  }
}

export interface ResultadoDoEstorno {
  readonly desfecho: DesfechoDoEstorno;
  readonly mensagemDoBling: string | null;
  readonly divergentes: number;
}

/** Estorno do cancelamento (se couber), conferido contra o saldo esperado, antes de alinhar o ORBITA. */
export async function prepararReleituraDoSaldo(
  deps: Pick<PedidoStatusDependencies, 'bling' | 'store' | 'aguardarProcessamentoBling'>,
  scope: VerifiedOrganizationScope,
  pedidoId: string,
  novoStatusCanonico: string,
  pedidoLocal: PedidoStatusPedido,
  evento: Evento,
): Promise<ResultadoDoEstorno> {
  if (novoStatusCanonico !== 'Cancelado' || mapBlingStatus(pedidoLocal.status) === 'Cancelado') {
    const desfecho: DesfechoDoEstorno = novoStatusCanonico === 'Cancelado' ? 'ja_cancelado' : 'nao_aplicavel';
    if (desfecho === 'ja_cancelado') await evento('order.stock_reversal', { resultado: desfecho, status_http: null });
    // O Bling roda as rotinas de estoque de forma assíncrona depois de aceitar
    // a mudança; ler o saldo imediatamente traria o valor antigo.
    await deps.aguardarProcessamentoBling();
    return { desfecho, mensagemDoBling: null, divergentes: 0 };
  }

  // A base é lida ANTES do estorno: depois dele não há como saber o que o saldo era.
  const esperado = await lerSaldoEsperado(scope, deps.store, deps.bling, pedidoId);
  const estorno = await semExcecao(() => deps.bling.estornarEstoque(pedidoLocal.bling_id));
  await deps.aguardarProcessamentoBling();

  let desfecho: DesfechoDoEstorno;
  let mensagemDoBling: string | null = null;
  let divergentes = 0;
  if (estorno._tag === 'BlingOk') {
    const contagem = esperado === null ? null : await contarDivergencias(scope, deps.bling, esperado);
    if (contagem === null) desfecho = 'sem_conferencia';
    else if (contagem > 0) {
      desfecho = 'divergente';
      divergentes = contagem;
    } else desfecho = 'estornado';
  } else {
    desfecho = classificarFalhaDeCriacaoNoBling(estorno.failure) === 'Definitiva' ? 'recusado' : 'desconhecido';
    mensagemDoBling = desfecho === 'recusado' ? estorno.failure.message : null;
  }
  await evento('order.stock_reversal', {
    resultado: desfecho,
    status_http: estorno._tag === 'BlingFailed' ? estorno.failure.status : null,
    produtos_divergentes: divergentes,
  });
  return { desfecho, mensagemDoBling, divergentes };
}

const AVISO_ESTORNO_RECUSADO = (mensagem: string | null) =>
  `Pedido cancelado, mas o Bling recusou o estorno do estoque${mensagem ? ` (${mensagem})` : ''}. `
  + 'Confira o saldo no Bling antes de qualquer ajuste; não repita o cancelamento.';
const AVISO_ESTORNO_DESCONHECIDO = 'Pedido cancelado, mas o Bling não confirmou o estorno do estoque, e ele pode ter sido aplicado. '
  + 'Confira o saldo no Bling antes de qualquer ajuste; não repita o cancelamento.';
const AVISO_ESTORNO_DIVERGENTE = (n: number) =>
  `Pedido cancelado e o Bling aceitou o estorno, mas o saldo de ${n} produto(s) não é o esperado `
  + '(saldo de antes + quantidade do pedido). O estorno não está confirmado: confira o saldo no Bling antes de qualquer ajuste; '
  + 'não repita o cancelamento.';
const AVISO_ESTORNO_SEM_CONFERENCIA = 'Pedido cancelado e o Bling aceitou o estorno, mas não foi possível conferir o saldo esperado. '
  + 'O estorno não está confirmado: confira o saldo no Bling antes de qualquer ajuste; não repita o cancelamento.';
const AVISO_JA_CANCELADO = 'O pedido já estava cancelado: nenhum novo estorno de estoque foi feito, para não devolver o estoque duas vezes.';

/** O aviso do estorno para o operador, ou `null` quando não há o que dizer. */
export function avisoDoEstorno(estorno: ResultadoDoEstorno): string | null {
  switch (estorno.desfecho) {
    case 'recusado': return AVISO_ESTORNO_RECUSADO(estorno.mensagemDoBling);
    case 'desconhecido': return AVISO_ESTORNO_DESCONHECIDO;
    case 'divergente': return AVISO_ESTORNO_DIVERGENTE(estorno.divergentes);
    case 'sem_conferencia': return AVISO_ESTORNO_SEM_CONFERENCIA;
    case 'ja_cancelado': return AVISO_JA_CANCELADO;
    default: return null;
  }
}

/** Estorno pedido e não confirmado pelo saldo: o estoque requer reconciliação. */
export function estornoNaoConfirmado(estorno: ResultadoDoEstorno): boolean {
  return estorno.desfecho !== 'nao_aplicavel' && estorno.desfecho !== 'estornado' && estorno.desfecho !== 'ja_cancelado';
}
