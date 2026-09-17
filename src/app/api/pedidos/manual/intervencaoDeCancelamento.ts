import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import { classificarFalhaDeCriacaoNoBling } from './classificacaoDeFalhaBling';
import type { ReconciliacaoDeps, ResultadoDaReconciliacao } from './reconciliacao';
import type { TentativaRegistrada } from './ports';

/**
 * A intervenção que escreve no ERP: cancelar o pedido órfão ("existe no Bling,
 * não existe no ORBITA") e encerrar a tentativa.
 *
 * Separada de `reconciliacao.ts` porque é a parte da reconciliação que MUDA
 * algo fora do ORBITA. Sequência: claim da intervenção no banco (reserva, para
 * que dois cancelamentos da mesma tentativa não rodem juntos) → `PATCH` de
 * cancelamento no Bling → finalização da intervenção e da tentativa numa única
 * transação do Postgres.
 *
 * O `PATCH` no Bling e a finalização local são dois passos separados, sem
 * transação comum. Por isso existem os desfechos `ambigua` (a resposta do
 * Bling não chegou) e "executado no Bling, mas não registrado no ORBITA".
 */

/**
 * A intervenção operacional explícita: cancela no Bling o pedido órfão e
 * encerra a tentativa.
 *
 * Depois de um cancelamento CONFIRMADO, o Bling não tem mais nada pendente para
 * esta referência, e a chave pode ser reaberta — a venda é registrada de novo
 * pelo fluxo normal.
 *
 * **Repetição.** Não se supõe que o Bling trate um segundo cancelamento como
 * inócuo. O que evita repetir o efeito é local: a elegibilidade é reavaliada
 * antes (uma tentativa `falhou` ou `concluida` nem chega aqui, ver
 * `tentativaPodeSerReconciliada`), e o claim recusa uma segunda intervenção
 * enquanto a anterior não tiver desfecho, ou tiver ficado `ambigua`.
 *
 * **Só grava `falhou` com o cancelamento confirmado.** Se o cancelamento
 * falhar, a tentativa permanece `indeterminada` — é a mesma regra da máquina
 * de estados de `compensacao.ts`: só uma compensação CONFIRMADA prova que
 * nada ficou pendente lá.
 */
export async function cancelarNoBlingEEncerrar(
  scope: VerifiedOrganizationScope,
  tentativa: TentativaRegistrada,
  blingPedidoId: string,
  deps: ReconciliacaoDeps,
  epoca: number,
): Promise<ResultadoDaReconciliacao> {
  // CLAIM ANTES DO EFEITO. Duas requisições simultâneas de cancelamento sobre
  // a mesma tentativa não podem produzir duas chamadas ao ERP. A exclusão é
  // NOSSA — índice único parcial —, não delegada a uma suposta idempotência do
  // provedor, que o contrato do Bling não afirma. O claim é, ao mesmo tempo, o
  // registro de auditoria.
  const claim = await deps.store.reivindicarIntervencao(scope, tentativa.id, 'cancelar-no-bling', blingPedidoId);

  if (claim._tag === 'IntervencaoJaEmAndamento') {
    return {
      _tag: 'NaoReconciliavel',
      motivo:
        'Já existe um cancelamento registrado para esta venda que ainda não teve desfecho confirmado. '
        + 'Ele precisa ser resolvido antes de qualquer nova tentativa de cancelar.',
      status: 409,
    };
  }
  if (claim._tag === 'IntervencaoIndisponivel') {
    registrarFalhaInterna('pedidos.manual.reconciliar.claim', claim.causa);
    return {
      _tag: 'NaoReconciliavel',
      motivo: 'Não foi possível registrar esta intervenção agora, então ela NÃO foi executada. Tente de novo em instantes.',
      status: 503,
    };
  }

  // A PARTIR DAQUI o cancelamento pode ter acontecido.
  // Uma exceção lançada — timeout, conexão perdida, abort — não prova que o
  // PATCH não chegou; prova só que a resposta não voltou.
  let cancelamento: Awaited<ReturnType<ReconciliacaoDeps['bling']['cancelarPedidoVenda']>>;
  try {
    cancelamento = await deps.bling.cancelarPedidoVenda(blingPedidoId);
  } catch (causa) {
    return encerrarComoAmbigua(scope, tentativa, claim.intervencaoId, blingPedidoId, deps, epoca, causa);
  }

  if (cancelamento._tag === 'BlingFailed') {
    registrarFalhaInterna('pedidos.manual.reconciliar.cancelar', new Error(cancelamento.failure.message));

    // A MESMA política da criação: só uma recusa que o contrato prova
    // (`error.type` de recusa da requisição, com status `4xx`) mostra que o
    // cancelamento não teve efeito. `429`, `408`, `5xx`, tipo desconhecido e
    // resposta ilegível deixam em aberto se o pedido foi cancelado.
    if (classificarFalhaDeCriacaoNoBling(cancelamento.failure) === 'Ambigua') {
      return encerrarComoAmbigua(
        scope, tentativa, claim.intervencaoId, blingPedidoId, deps, epoca,
        new Error(cancelamento.failure.message),
      );
    }

    // Recusa comprovada: o pedido segue lá, intacto, e a tentativa continua
    // bloqueada. A intervenção fecha como `falhou`, liberando o claim para uma
    // nova tentativa de cancelar — porque comprovadamente nada mudou no ERP.
    const persistencia = await deps.store.finalizarIntervencaoETentativa({
      scope,
      intervencaoId: claim.intervencaoId,
      tentativaId: tentativa.id,
      resultadoIntervencao: 'falhou',
      estadoTentativa: 'indeterminada',
      blingPedidoId,
      detalhe: cancelamento.failure.message,
      epocaEsperada: epoca,
    });
    if (persistencia._tag === 'NaoPersistiu') return respostaDeFalhaAoPersistir(persistencia.causa);

    return {
      _tag: 'NaoReconciliavel',
      motivo:
        `O Bling recusou o cancelamento do pedido ${blingPedidoId} (${cancelamento.failure.message}). `
        + 'A tentativa continua bloqueada: cancele o pedido no Bling manualmente e confira de novo.',
      status: 502,
    };
  }

  // Cancelamento CONFIRMADO. A gravação local não pode ser fire-and-forget: se
  // ela falhar, a resposta não pode dizer que a referência foi liberada.
  const persistencia = await deps.store.finalizarIntervencaoETentativa({
    scope,
    intervencaoId: claim.intervencaoId,
    tentativaId: tentativa.id,
    resultadoIntervencao: 'confirmada',
    estadoTentativa: 'falhou',
    blingPedidoId,
    detalhe: null,
    epocaEsperada: epoca,
  });
  if (persistencia._tag === 'NaoPersistiu') return respostaDeFalhaAoPersistir(persistencia.causa);

  return { _tag: 'CanceladoNoBling', tentativaId: tentativa.id, blingPedidoId };
}

/**
 * O cancelamento pode ter acontecido e não sabemos.
 *
 * A intervenção fecha como `ambigua` — que **não** libera o claim (o índice
 * parcial cobre `resultado is null or resultado = 'ambigua'`), justamente para
 * impedir que outra intervenção repita a mutação sobre o mesmo pedido. Sair
 * daqui exige descobrir o que de fato aconteceu.
 */
async function encerrarComoAmbigua(
  scope: VerifiedOrganizationScope,
  tentativa: TentativaRegistrada,
  intervencaoId: string,
  blingPedidoId: string,
  deps: ReconciliacaoDeps,
  epoca: number,
  causa: unknown,
): Promise<ResultadoDaReconciliacao> {
  registrarFalhaInterna('pedidos.manual.reconciliar.cancelar.ambiguo', causa);

  const persistencia = await deps.store.finalizarIntervencaoETentativa({
    scope,
    intervencaoId,
    tentativaId: tentativa.id,
    resultadoIntervencao: 'ambigua',
    estadoTentativa: 'indeterminada',
    blingPedidoId,
    detalhe: 'A resposta do cancelamento não chegou; não se sabe se ele teve efeito.',
    epocaEsperada: epoca,
  });
  if (persistencia._tag === 'NaoPersistiu') return respostaDeFalhaAoPersistir(persistencia.causa);

  return { _tag: 'CancelamentoAmbiguo', tentativaId: tentativa.id, blingPedidoId };
}

/**
 * A finalização local da intervenção (`finalizarIntervencaoETentativa`) não
 * pôde ser confirmada.
 *
 * O desfecho remoto depende do ponto de chamada: o cancelamento no Bling pode
 * ter sido confirmado, ter ficado ambíguo ou ter sido recusado. Como não se
 * sabe o que ficou registrado localmente, esta resposta é sempre
 * `NaoReconciliavel` e nunca declara a referência liberada.
 *
 * Este resultado, sozinho, não autoriza repetir a mutação remota: a próxima
 * ação deve partir de uma nova conferência do estado atual.
 */
function respostaDeFalhaAoPersistir(causa: unknown): ResultadoDaReconciliacao {
  registrarFalhaInterna('pedidos.manual.reconciliar.persistencia', causa);
  return {
    _tag: 'NaoReconciliavel',
    motivo:
      'A ação foi executada no Bling, mas o ORBITA não conseguiu registrar o resultado. '
      + 'A venda continua bloqueada de propósito — confira de novo em instantes para o registro convergir. '
      + 'NÃO repita o cancelamento.',
    status: 503,
  };
}
