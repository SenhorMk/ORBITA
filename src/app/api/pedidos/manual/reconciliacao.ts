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

export type ResultadoDaReconciliacao =
  | { readonly _tag: 'NadaFoiCriado'; readonly tentativaId: string }
  | { readonly _tag: 'VendaConfirmada'; readonly tentativaId: string; readonly pedidoId: string; readonly blingPedidoId: string }
  | { readonly _tag: 'PendenteNoBling'; readonly tentativaId: string; readonly blingPedidoId: string }
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

  const pedidoNoBling = busca.value;

  if (pedidoNoBling === null) {
    // Resposta NEGATIVA confirmada: o Bling respondeu, e não existe pedido com
    // esta referência. Nada foi criado — a tentativa pode ser encerrada e a
    // referência liberada para uma retentativa da mesma venda.
    await deps.store.registrarDesfechoDaTentativa(scope, tentativa.id, { estado: 'falhou' });
    return { _tag: 'NadaFoiCriado', tentativaId: tentativa.id };
  }

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

  // O pedido existe no Bling e a venda não existe aqui. A tentativa continua
  // bloqueada — mas agora com o `bling_id` que faltava gravado nela, que é o
  // que torna a resolução manual possível.
  await deps.store.registrarDesfechoDaTentativa(scope, tentativa.id, {
    estado: 'indeterminada',
    blingPedidoId: pedidoNoBling.id,
  });
  return { _tag: 'PendenteNoBling', tentativaId: tentativa.id, blingPedidoId: pedidoNoBling.id };
}

/** Corpo de resposta de `POST /api/pedidos/manual/reconciliar`. */
export interface RespostaDaReconciliacao {
  readonly success: boolean;
  /** `true` quando a referência foi liberada e o cliente pode esquecê-la. */
  readonly referenciaLiberada: boolean;
  readonly situacao: 'nada_foi_criado' | 'venda_confirmada' | 'pendente_no_bling' | 'nao_reconciliavel';
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

  return NextResponse.json(
    {
      success: false,
      referenciaLiberada: false,
      situacao: 'pendente_no_bling',
      mensagem:
        `Conferido no Bling: o pedido ${resultado.blingPedidoId} existe lá, mas a venda não foi gravada no ORBITA. `
        + 'Esta tentativa continua bloqueada de propósito — resolver exige decidir entre cancelar o pedido no Bling '
        + 'ou registrar a venda aqui, e nenhuma das duas coisas pode ser feita automaticamente.',
      blingPedidoId: resultado.blingPedidoId,
    } satisfies RespostaDaReconciliacao,
    { status: 409 },
  );
}
