/**
 * Saída de uma tentativa que ficou **indeterminada** (ticket 30, fatia 3 —
 * 5ª rodada de revisão).
 *
 * ## O problema que isto fecha
 *
 * As rodadas anteriores ensinaram o sistema a BLOQUEAR uma tentativa cujo
 * desfecho ninguém confirmou. Isso é o comportamento seguro, e sozinho é
 * incompleto: sem um caminho de saída, "seguro" vira "esta venda está
 * bloqueada para sempre; limpe o `localStorage` e tente de novo" — e apagar a
 * chave de idempotência é exatamente furar a proteção contra duplicação. A
 * remoção manual da chave não pode ser o mecanismo normal de resolver
 * incerteza.
 *
 * O ciclo passa a ser: `indeterminada` → **reconciliar** → `concluida` ou
 * `falhou` → liberada.
 *
 * ## Como se pergunta ao Bling sem ter o `bling_id`
 *
 * Este é o caso difícil, e o que a revisão pediu para provar: quando a própria
 * criação no Bling perde o ACK, o ORBITA nem sabe o id do pedido. Mas sabe a
 * `referenciaLocal` — ela é decidida ANTES do envio e viaja ao Bling em
 * `numeroLoja` (`handler.ts`, `buildPedidoVendaPayload`). É a única coisa que
 * os dois lados compartilham nesse estado, e é suficiente:
 * `GET /pedidos/vendas?numerosLojas[]=<referencia>` é filtro oficial da API v3
 * ("Conjunto de números de pedidos nas lojas"), conferido no OpenAPI publicado
 * — ver `docs/integrations/bling-v3-contract.md`.
 *
 * ## Os três desfechos
 *
 * | O Bling tem o pedido? | O ORBITA tem a venda? | Conclusão | Libera? |
 * |---|---|---|---|
 * | não | (irrelevante) | `falhou` — nada foi criado | **sim**, retentar é seguro |
 * | sim | sim | `concluida` — só a confirmação se perdeu | **sim**, como já registrada |
 * | sim | não | permanece bloqueada, agora com o `bling_id` descoberto | **não** |
 *
 * A terceira linha é o único caso que sobra para uma pessoa, e ela sai daqui
 * MUITO melhor do que entrou: em vez de "não se sabe o que aconteceu", é "o
 * pedido X existe no Bling e não existe no ORBITA". Resolver isso exige
 * escrever em algum dos dois lados (cancelar lá ou registrar aqui), e esta
 * rota **não** decide isso sozinha — escrita no ERP é decisão do proprietário,
 * não de uma reconciliação automática.
 */

import { NextResponse } from 'next/server';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import type { ManualOrderDependencies, TentativaRegistrada } from './ports';

/**
 * O que a reconciliação precisa: ler o ledger, ler o Bling, gravar o desfecho
 * e saber que horas são. Não precisa de `auth` (a rota já resolveu o escopo)
 * nem de `dormir`/`newLocalReference` — pedir só o necessário mantém o teste
 * pequeno e diz, pelo tipo, que esta função não cria nada.
 */
export type ReconciliacaoDeps = Pick<ManualOrderDependencies, 'store' | 'bling' | 'now'>;

/** Idade mínima para reconciliar uma tentativa ainda `em_andamento`. */
const IDADE_MINIMA_PARA_RECONCILIAR_EM_ANDAMENTO_MS = 2 * 60 * 1000;

/**
 * O que a reconciliação deve FAZER, além de diagnosticar.
 *
 * - `'conferir'` (padrão): **só leitura**. Pergunta ao Bling e conclui a
 *   tentativa apenas quando a resposta é determinante por si só.
 * - `'cancelar-no-bling'`: a intervenção operacional explícita para o único
 *   desfecho que a conferência não resolve sozinha — o pedido existe no Bling
 *   e a venda não existe no ORBITA. **Escreve no ERP** e por isso nunca é o
 *   padrão: precisa ser pedida nomeadamente.
 */
export type AcaoDeReconciliacao = 'conferir' | 'cancelar-no-bling';

export type ResultadoDaReconciliacao =
  | { readonly _tag: 'NadaFoiCriado'; readonly tentativaId: string }
  | { readonly _tag: 'VendaConfirmada'; readonly tentativaId: string; readonly pedidoId: string; readonly blingPedidoId: string }
  | { readonly _tag: 'PendenteNoBling'; readonly tentativaId: string; readonly blingPedidoId: string }
  /** Cancelamento CONFIRMADO no Bling: nada ficou pendente lá, e a chave foi liberada. */
  | { readonly _tag: 'CanceladoNoBling'; readonly tentativaId: string; readonly blingPedidoId: string }
  | { readonly _tag: 'NaoReconciliavel'; readonly motivo: string; readonly status: number };

/**
 * Decide se uma tentativa pode ser reconciliada agora.
 *
 * `em_andamento` recente é uma requisição possivelmente **em voo neste
 * momento** — reconciliar por cima dela concluiria uma tentativa que ainda vai
 * responder. Só depois de uma idade muito maior que a janela de confirmação
 * (~2,8s) e que qualquer timeout de requisição é que "em andamento" significa,
 * de fato, "travada".
 */
export function tentativaPodeSerReconciliada(
  tentativa: TentativaRegistrada,
  agora: Date,
): { readonly pode: true } | { readonly pode: false; readonly motivo: string; readonly status: number } {
  if (tentativa.estado === 'concluida') {
    return { pode: false, motivo: 'Esta venda já está registrada; não há nada a reconciliar.', status: 409 };
  }
  if (tentativa.estado === 'falhou') {
    return { pode: false, motivo: 'Esta tentativa já foi encerrada como não realizada; pode registrar a venda de novo.', status: 409 };
  }
  if (tentativa.estado === 'em_andamento') {
    const idadeMs = agora.getTime() - new Date(tentativa.atualizadaEm).getTime();
    if (idadeMs < IDADE_MINIMA_PARA_RECONCILIAR_EM_ANDAMENTO_MS) {
      return {
        pode: false,
        motivo: 'Esta venda ainda está sendo processada. Aguarde a resposta antes de conferir.',
        status: 409,
      };
    }
  }
  return { pode: true };
}

/**
 * Pergunta ao Bling, pela referência local, o que de fato aconteceu — e
 * conclui a tentativa quando a resposta é determinante.
 *
 * **Não escreve nada no Bling.** Só lê. As duas conclusões que ela grava são
 * no ledger local, e as duas são deduções de uma resposta do provedor, nunca
 * de um palpite.
 */
export async function reconciliarTentativa(
  scope: VerifiedOrganizationScope,
  referenciaLocal: string,
  tentativa: TentativaRegistrada,
  deps: ReconciliacaoDeps,
  acao: AcaoDeReconciliacao = 'conferir',
): Promise<ResultadoDaReconciliacao> {
  const busca = await deps.bling.buscarPedidoPorNumeroLoja(referenciaLocal);

  if (busca._tag === 'BlingFailed') {
    registrarFalhaInterna('pedidos.manual.reconciliar.busca', new Error(busca.failure.message));
    return {
      _tag: 'NaoReconciliavel',
      motivo: 'Não foi possível consultar o Bling agora. A venda continua bloqueada de propósito; tente conferir de novo em instantes.',
      status: 503,
    };
  }

  const encontrado = busca.value;

  // CARDINALIDADE EXPLÍCITA (6ª rodada de revisão). Mais de um pedido com a
  // MESMA referência não deveria existir — ver a unicidade do `numeroLoja`
  // abaixo — e por isso mesmo não pode ser resolvido escolhendo "o primeiro":
  // associar a tentativa ao pedido errado conclui a venda errada.
  if (encontrado._tag === 'VariosPedidos') {
    registrarFalhaInterna(
      'pedidos.manual.reconciliar.varios',
      new Error(`${encontrado.quantidade} pedidos no Bling com a mesma referência: ${encontrado.ids.join(', ')}`),
    );
    return {
      _tag: 'NaoReconciliavel',
      motivo:
        `Foram encontrados ${encontrado.quantidade} pedidos no Bling com esta mesma referência. `
        + 'Não é possível concluir automaticamente qual deles corresponde a esta venda — '
        + 'a tentativa continua bloqueada e precisa de conferência manual no Bling.',
      status: 409,
    };
  }

  if (encontrado._tag === 'NenhumPedido') {
    // Resposta NEGATIVA confirmada: o Bling respondeu, e não existe pedido com
    // esta referência. Nada foi criado — a tentativa pode ser encerrada e a
    // referência liberada para uma retentativa da mesma venda.
    await deps.store.registrarDesfechoDaTentativa(scope, tentativa.id, { estado: 'falhou' });
    return { _tag: 'NadaFoiCriado', tentativaId: tentativa.id };
  }

  const pedidoNoBling = encontrado.pedido;
  const jaRegistrada = await deps.store.findVendaManualJaRegistrada(scope, pedidoNoBling.id);
  if (jaRegistrada !== null) {
    // Os dois lados têm a venda: o que se perdeu foi só a confirmação.
    await deps.store.registrarDesfechoDaTentativa(scope, tentativa.id, {
      estado: 'concluida',
      pedidoId: jaRegistrada.pedidoId,
      blingPedidoId: pedidoNoBling.id,
    });
    return {
      _tag: 'VendaConfirmada',
      tentativaId: tentativa.id,
      pedidoId: jaRegistrada.pedidoId,
      blingPedidoId: pedidoNoBling.id,
    };
  }

  // O pedido existe no Bling e a venda não existe aqui — o único desfecho que
  // a conferência não resolve sozinha. Grava o `bling_id` descoberto de
  // qualquer forma: é ele que torna a resolução possível, e sem ele a
  // tentativa fica cega.
  await deps.store.registrarDesfechoDaTentativa(scope, tentativa.id, {
    estado: 'indeterminada',
    blingPedidoId: pedidoNoBling.id,
  });

  if (acao === 'conferir') {
    return { _tag: 'PendenteNoBling', tentativaId: tentativa.id, blingPedidoId: pedidoNoBling.id };
  }

  return cancelarNoBlingEEncerrar(scope, tentativa, pedidoNoBling.id, deps);
}

/**
 * A intervenção operacional explícita: cancela no Bling o pedido órfão e
 * encerra a tentativa (ticket 30 — 6ª rodada de revisão).
 *
 * É o caminho que faltava para o terceiro desfecho não terminar em "fica
 * bloqueada para sempre". Depois de um cancelamento CONFIRMADO, o Bling não
 * tem mais nada pendente para esta referência, e a chave pode ser reaberta com
 * segurança — a venda é registrada de novo pelo fluxo normal.
 *
 * **Idempotente.** Cancelar um pedido já cancelado é inócuo no Bling, e a
 * elegibilidade é reavaliada antes (uma tentativa já `falhou` ou `concluida`
 * nem chega aqui, ver `tentativaPodeSerReconciliada`). Repetir a intervenção
 * converge para o mesmo estado em vez de acumular efeito.
 *
 * **Só grava `falhou` com o cancelamento confirmado.** Se o cancelamento
 * falhar, a tentativa permanece `indeterminada` — é a mesma regra da máquina
 * de estados de `compensacao.ts`: só uma compensação CONFIRMADA prova que
 * nada ficou pendente lá.
 */
async function cancelarNoBlingEEncerrar(
  scope: VerifiedOrganizationScope,
  tentativa: TentativaRegistrada,
  blingPedidoId: string,
  deps: ReconciliacaoDeps,
): Promise<ResultadoDaReconciliacao> {
  const cancelamento = await deps.bling.cancelarPedidoVenda(blingPedidoId);

  if (cancelamento._tag === 'BlingFailed') {
    registrarFalhaInterna('pedidos.manual.reconciliar.cancelar', new Error(cancelamento.failure.message));
    return {
      _tag: 'NaoReconciliavel',
      motivo:
        `O pedido ${blingPedidoId} existe no Bling e o cancelamento automático falhou `
        + `(${cancelamento.failure.message}). A tentativa continua bloqueada de propósito: `
        + 'cancele o pedido no Bling manualmente e confira de novo.',
      status: 502,
    };
  }

  await deps.store.registrarDesfechoDaTentativa(scope, tentativa.id, { estado: 'falhou', blingPedidoId });
  return { _tag: 'CanceladoNoBling', tentativaId: tentativa.id, blingPedidoId };
}

/** Corpo de resposta de `POST /api/pedidos/manual/reconciliar`. */
export interface RespostaDaReconciliacao {
  readonly success: boolean;
  /** `true` quando a referência foi liberada e o cliente pode esquecê-la. */
  readonly referenciaLiberada: boolean;
  readonly situacao: 'nada_foi_criado' | 'venda_confirmada' | 'pendente_no_bling' | 'cancelado_no_bling' | 'nao_reconciliavel';
  readonly mensagem: string;
  readonly pedidoId?: string;
  readonly blingPedidoId?: string;
}

/** Traduz o desfecho da reconciliação para a resposta HTTP. */
export function respostaDaReconciliacao(resultado: ResultadoDaReconciliacao): NextResponse {
  if (resultado._tag === 'NaoReconciliavel') {
    return NextResponse.json(
      { success: false, referenciaLiberada: false, situacao: 'nao_reconciliavel', mensagem: resultado.motivo } satisfies RespostaDaReconciliacao,
      { status: resultado.status },
    );
  }

  if (resultado._tag === 'NadaFoiCriado') {
    return NextResponse.json(
      {
        success: true,
        referenciaLiberada: true,
        situacao: 'nada_foi_criado',
        mensagem: 'Conferido no Bling: o pedido não chegou a ser criado. Nada ficou pendente lá, e a venda pode ser registrada de novo.',
      } satisfies RespostaDaReconciliacao,
      { status: 200 },
    );
  }

  if (resultado._tag === 'VendaConfirmada') {
    return NextResponse.json(
      {
        success: true,
        referenciaLiberada: true,
        situacao: 'venda_confirmada',
        mensagem: 'Conferido no Bling: a venda foi registrada nos dois lados. Só a confirmação tinha se perdido.',
        pedidoId: resultado.pedidoId,
        blingPedidoId: resultado.blingPedidoId,
      } satisfies RespostaDaReconciliacao,
      { status: 200 },
    );
  }

  if (resultado._tag === 'CanceladoNoBling') {
    return NextResponse.json(
      {
        success: true,
        referenciaLiberada: true,
        situacao: 'cancelado_no_bling',
        mensagem:
          `O pedido ${resultado.blingPedidoId} foi cancelado no Bling e nada ficou pendente lá. `
          + 'Esta venda pode ser registrada de novo.',
        blingPedidoId: resultado.blingPedidoId,
      } satisfies RespostaDaReconciliacao,
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      success: false,
      referenciaLiberada: false,
      situacao: 'pendente_no_bling',
      mensagem:
        `Conferido no Bling: o pedido ${resultado.blingPedidoId} existe lá, mas a venda não foi gravada no ORBITA. `
        + 'Esta tentativa continua bloqueada de propósito. Para encerrá-la, peça o cancelamento do pedido no '
        + 'Bling — é uma ação explícita, e não acontece por conferência.',
      blingPedidoId: resultado.blingPedidoId,
    } satisfies RespostaDaReconciliacao,
    { status: 409 },
  );
}
