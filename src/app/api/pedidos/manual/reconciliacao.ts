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

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import { cancelarNoBlingEEncerrar } from './intervencaoDeCancelamento';
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
 * - `'cancelar-no-bling'`: a intervenção operacional explícita para o
 *   desfecho "o pedido existe no Bling e a venda não existe no ORBITA".
 *   **Escreve no ERP** e por isso nunca é o padrão.
 * - `'encerrar-como-nao-criada'`: a decisão HUMANA de que o pedido nunca foi
 *   criado, para o caso em que a consulta não encontra nada. Ela existe
 *   porque **a ausência não é prova** (7ª rodada de revisão): o contrato do
 *   Bling não promete visibilidade imediata depois de um `POST`, então "o GET
 *   não achou agora" não pode, sozinho, liberar a chave. Quem confere no ERP
 *   e conclui que não existe pedido assume essa conclusão nomeadamente.
 */
export type AcaoDeReconciliacao = 'conferir' | 'cancelar-no-bling' | 'encerrar-como-nao-criada';

export type ResultadoDaReconciliacao =
  /**
   * A consulta não encontrou pedido — e isso **não** conclui nada. A chave
   * continua bloqueada; encerrar exige a decisão explícita
   * `encerrar-como-nao-criada`.
   */
  | { readonly _tag: 'NenhumPedidoVisivel'; readonly tentativaId: string }
  /** A decisão humana de que nunca houve pedido. Encerra e libera. */
  | { readonly _tag: 'EncerradaComoNaoCriada'; readonly tentativaId: string }
  | { readonly _tag: 'VendaConfirmada'; readonly tentativaId: string; readonly pedidoId: string; readonly blingPedidoId: string }
  | { readonly _tag: 'PendenteNoBling'; readonly tentativaId: string; readonly blingPedidoId: string }
  /** Cancelamento CONFIRMADO no Bling: nada ficou pendente lá, e a chave foi liberada. */
  | { readonly _tag: 'CanceladoNoBling'; readonly tentativaId: string; readonly blingPedidoId: string }
  /**
   * O cancelamento foi despachado e a resposta não chegou. Pode ter acontecido.
   * A intervenção fica `ambigua`, o claim NÃO é liberado, e nenhuma nova
   * mutação sobre este pedido é permitida até alguém descobrir o que houve.
   */
  | { readonly _tag: 'CancelamentoAmbiguo'; readonly tentativaId: string; readonly blingPedidoId: string }
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
  // FENCING (8ª rodada de revisão). Uma tentativa `em_andamento` velha pode
  // ter um executor original AINDA VIVO. Idade não é sincronização, e CAS
  // sozinho não é fencing: ele protegia só o sentido "handler conclui e a
  // reconciliação perde". No sentido inverso — reconciliação vence, libera o
  // fingerprint, e o handler antigo retoma e grava incondicionalmente — não
  // havia nada. Reproduzido contra Postgres real; ver
  // `scripts/database-concurrency-fencing.mjs`.
  //
  // Tomar a posse avança a época, e com isso o executor anterior deixa de
  // poder escrever (`55P03`).
  let epoca = tentativa.epoca;
  if (tentativa.estado === 'em_andamento') {
    const posse = await deps.store.assumirTentativaParaReconciliacao(scope, tentativa.id, tentativa.epoca);
    if (posse._tag === 'PosseNegada') {
      return {
        _tag: 'NaoReconciliavel',
        motivo: 'Esta venda mudou de estado enquanto era conferida. Confira de novo para ver a situação atual.',
        status: 409,
      };
    }
    if (posse._tag === 'PosseIndisponivel') {
      registrarFalhaInterna('pedidos.manual.reconciliar.posse', posse.causa);
      return {
        _tag: 'NaoReconciliavel',
        motivo: 'Não foi possível assumir esta venda para conferência agora. Tente de novo em instantes.',
        status: 503,
      };
    }
    epoca = posse.epoca;
  }

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
    // AUSÊNCIA NÃO É PROVA (7ª rodada de revisão).
    //
    // A versão anterior concluía `falhou` aqui e liberava a chave, tratando
    // "o GET não achou" como "o POST nunca criou". Isso exige uma garantia de
    // read-after-write que **o contrato do Bling não dá**: o OpenAPI oficial
    // não menciona consistência, propagação, latência ou visibilidade em
    // lugar nenhum (conferido termo a termo — ver
    // `evidence/30-visibilidade-do-bling-*.md`), e as descrições de
    // `POST /pedidos/vendas` e `GET /pedidos/vendas` são de uma linha cada.
    //
    // Sem essa garantia, liberar aqui reabre a chave numa janela em que o
    // pedido pode existir e ainda não estar visível — e a retentativa cria o
    // segundo. Então a conferência **não conclui nada** neste caso: relata a
    // ausência e mantém o bloqueio.
    if (acao !== 'encerrar-como-nao-criada') {
      return { _tag: 'NenhumPedidoVisivel', tentativaId: tentativa.id };
    }

    // A decisão humana, pedida nomeadamente: alguém conferiu no ERP e assume
    // que o pedido não existe. Só então a chave é liberada.
    await deps.store.registrarDesfechoDaTentativa(scope, tentativa.id, { estado: 'falhou' }, undefined, epoca);
    return { _tag: 'EncerradaComoNaoCriada', tentativaId: tentativa.id };
  }

  const pedidoNoBling = encontrado.pedido;
  const jaRegistrada = await deps.store.findVendaManualJaRegistrada(scope, pedidoNoBling.id);
  if (jaRegistrada !== null) {
    // Os dois lados têm a venda: o que se perdeu foi só a confirmação.
    await deps.store.registrarDesfechoDaTentativa(
      scope,
      tentativa.id,
      { estado: 'concluida', pedidoId: jaRegistrada.pedidoId, blingPedidoId: pedidoNoBling.id },
      undefined,
      epoca,
    );
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
  await deps.store.registrarDesfechoDaTentativa(
    scope,
    tentativa.id,
    { estado: 'indeterminada', blingPedidoId: pedidoNoBling.id },
    undefined,
    epoca,
  );

  if (acao !== 'cancelar-no-bling') {
    return { _tag: 'PendenteNoBling', tentativaId: tentativa.id, blingPedidoId: pedidoNoBling.id };
  }

  return cancelarNoBlingEEncerrar(scope, tentativa, pedidoNoBling.id, deps, epoca);
}
