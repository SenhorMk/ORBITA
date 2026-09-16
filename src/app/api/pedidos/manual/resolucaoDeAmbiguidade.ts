/**
 * A saída da intervenção de cancelamento que ficou `ambigua`, e a resposta
 * padrão para quando o ledger não gravou uma conclusão.
 *
 * Separado de `reconciliacao.ts` porque é um caminho próprio: não consulta o
 * Bling, não toma posse, não compensa. Uma pessoa conferiu o ERP e registra o
 * que viu; o sistema só guarda essa decisão.
 */
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type { DecisaoDeAmbiguidade, TentativaRegistrada } from './ports';
import type { ReconciliacaoDeps, ResultadoDaReconciliacao } from './reconciliacao';

/** O que a rota precisa saber para registrar a decisão sobre uma ambiguidade. */
export interface ResolucaoPedida {
  readonly decisao: DecisaoDeAmbiguidade;
  readonly evidencia: string;
}

/**
 * Encerra a intervenção `ambigua` com a decisão humana.
 *
 * Não fala com o Bling: a pessoa já foi lá e está afirmando o que viu. A
 * gravação é append-only — o fato original continua `ambigua`, e a decisão
 * nova vira uma linha própria com ator, instante e evidência próprios.
 */
export async function resolverAmbiguidade(
  scope: VerifiedOrganizationScope,
  tentativa: TentativaRegistrada,
  deps: ReconciliacaoDeps,
  resolucao: ResolucaoPedida | undefined,
): Promise<ResultadoDaReconciliacao> {
  if (!resolucao) {
    return {
      _tag: 'NaoReconciliavel',
      motivo: 'Resolver uma ambiguidade exige informar a decisão observada no Bling e a evidência.',
      status: 400,
    };
  }

  const efeito = await deps.store.resolverIntervencaoAmbigua({
    scope,
    tentativaId: tentativa.id,
    decisao: resolucao.decisao,
    evidencia: resolucao.evidencia,
    epocaEsperada: tentativa.epoca,
  });

  if (efeito._tag === 'AmbiguidadeResolvida') {
    return { _tag: 'AmbiguidadeResolvida', tentativaId: tentativa.id, liberou: resolucao.decisao === 'cancelado' };
  }
  if (efeito._tag === 'SemAmbiguidadePendente') {
    return {
      _tag: 'NaoReconciliavel',
      motivo: 'Não há cancelamento ambíguo pendente para esta venda.',
      status: 409,
    };
  }
  if (efeito._tag === 'AmbiguidadeJaResolvida') {
    return {
      _tag: 'NaoReconciliavel',
      motivo: 'Outra pessoa já registrou a decisão sobre este cancelamento. Confira a situação atual.',
      status: 409,
    };
  }
  if (efeito._tag === 'ResolucaoSemPosse') {
    return {
      _tag: 'NaoReconciliavel',
      motivo: 'Esta venda mudou de estado enquanto a decisão era registrada. Confira de novo antes de decidir.',
      status: 409,
    };
  }

  registrarFalhaInterna('pedidos.manual.reconciliar.resolver', efeito.causa);
  return {
    _tag: 'NaoReconciliavel',
    motivo: 'Não foi possível registrar a decisão agora, então ela NÃO foi registrada. Tente de novo em instantes.',
    status: 503,
  };
}

/**
 * O ledger não gravou: a resposta não pode dizer que a referência foi
 * liberada, porque nada foi liberado.
 */
export function ledgerNaoGravado(causa: unknown): ResultadoDaReconciliacao {
  registrarFalhaInterna('pedidos.manual.reconciliar.ledger', causa);
  return {
    _tag: 'NaoReconciliavel',
    motivo:
      'A conferência descobriu a situação, mas o ORBITA não conseguiu registrá-la. A venda continua '
      + 'bloqueada de propósito — confira de novo em instantes para o registro convergir.',
    status: 503,
  };
}
