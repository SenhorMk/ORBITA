import { NextResponse } from 'next/server';
import { z } from 'zod';

import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { criarManualOrderDependencies, newLocalReference } from '../dependencias';
import {
  reconciliarTentativa,
  tentativaPodeSerReconciliada,
  type AcaoDeReconciliacao,
  type ResolucaoPedida,
} from '../reconciliacao';
import { respostaDaReconciliacao } from '../respostaDaReconciliacao';

/**
 * `POST /api/pedidos/manual/reconciliar` — o caminho de saída de uma tentativa
 * de venda manual que ficou indeterminada (ticket 30, fatia 3).
 *
 * Bloquear uma tentativa cujo desfecho ninguém confirmou é o comportamento
 * seguro; sem esta rota, seria também um beco sem saída, cuja única "solução"
 * seria apagar a chave de idempotência do navegador — ou seja, furar
 * exatamente a proteção contra duplicação. Ver `reconciliacao.ts` para a
 * máquina de estados e para como se pergunta ao Bling sem ter o `bling_id`.
 *
 * **Autorização pelo EFEITO, não pelo nome da ação (9ª rodada, B5).** A 8ª
 * rodada classificava `conferir` como leitura porque ela se chama assim — e o
 * que ela fazia era tomar posse da tentativa (avançando a época) e escrever no
 * ledger. Um `member`, com apenas `organization:access`, conseguia com isso
 * CERCAR um executor legítimo e alterar o desfecho de uma venda.
 *
 * Agora: qualquer alteração de posse, de ledger ou do ERP exige
 * `organization:manage`. Sem gestão, `conferir` continua disponível, mas como
 * INSPEÇÃO de verdade — não escreve nada e nunca declara a referência
 * liberada.
 */

/**
 * A ação de encerrar uma tentativa que a API não conseguiu provar inexistente
 * **ainda não foi aprovada como comportamento de produto**.
 *
 * Ela é um override humano: "conferi direto no Bling, aceito que a API não
 * provou a ausência, e confirmo que este pedido não existe; libere esta
 * tentativa". Isso é decisão da proprietária — envolve aceitar que uma pessoa
 * assuma uma afirmação que o provedor não sustenta (ver
 * `evidence/30-visibilidade-do-bling-e-ausencia-2026-09-03.md`) — e ela não
 * foi tomada.
 *
 * Enquanto não for, a rota **reconhece** a ação, para que o caminho fique
 * testável de ponta a ponta, e **recusa executá-la**. Virar `true` é uma
 * decisão de produto, não uma correção técnica.
 */
export const OVERRIDE_ENCERRAR_APROVADO_PELA_PROPRIETARIA = false;

const corpoSchema = z.object({
  /** O UUID que o cliente guardou; a rota o converte na referência completa. */
  referenciaLocal: z.string().uuid('referenciaLocal precisa ser um UUID'),
  /**
   * `'conferir'` (padrão) é a única que um papel sem gestão alcança, e nesse
   * caso ela é inspeção pura. As demais mudam estado, escrevem no ERP ou
   * registram decisão, e precisam ser pedidas nomeadamente.
   */
  acao: z
    .enum(['conferir', 'cancelar-no-bling', 'encerrar-como-nao-criada', 'resolver-ambiguidade'])
    .default('conferir'),
  /**
   * Só para `resolver-ambiguidade`: o que a pessoa observou no Bling sobre o
   * pedido cujo cancelamento ficou sem resposta (9ª rodada, B3).
   */
  decisao: z.enum(['cancelado', 'nao-cancelado']).optional(),
  /**
   * A evidência da observação. Obrigatória junto com a decisão: uma afirmação
   * que o provedor não confirmou precisa dizer em que se apoia.
   */
  evidencia: z.string().trim().min(1).max(500).optional(),
});

/**
 * Toda ação diferente de `conferir` muda o mundo — ERP, ledger ou registro de
 * decisão — e por isso exige gestão. `conferir` é a única que existe nos dois
 * modos, e o modo é decidido pela capacidade, não pelo nome.
 */
function exigeGestao(acao: AcaoDeReconciliacao): boolean {
  return acao !== 'conferir';
}

function negado(mensagem: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error: mensagem }, { status });
}

/**
 * Autoriza a ação pelo escopo VERIFICADO — o papel vem do vínculo persistido,
 * nunca do corpo, da query nem de qualquer coisa que o cliente controle.
 */
function autorizar(scope: VerifiedOrganizationScope, acao: AcaoDeReconciliacao): NextResponse | null {
  if (exigeGestao(acao) && !escopoTemCapacidade(scope, 'organization:manage')) {
    return negado('Esta ação exige permissão de gestão da organização.', 403);
  }
  if (acao === 'encerrar-como-nao-criada' && !OVERRIDE_ENCERRAR_APROVADO_PELA_PROPRIETARIA) {
    return negado(
      'Encerrar uma venda que a consulta ao Bling não conseguiu descartar ainda não está liberado: '
        + 'depende de uma decisão da proprietária sobre permitir essa confirmação manual. '
        + 'Por enquanto, a venda permanece bloqueada.',
      403,
    );
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return negado('Corpo da requisição não é um JSON válido.', 400);
  }

  const parsed = corpoSchema.safeParse(rawBody);
  if (!parsed.success) {
    return negado('Referência da venda inválida.', 400);
  }
  const { acao } = parsed.data;

  // Autorização ANTES de qualquer leitura de ledger, chamada ao provedor ou
  // reivindicação de claim: um papel sem gestão não deve nem conseguir
  // descobrir o que existe, muito menos disparar efeito.
  const recusa = autorizar(scope, acao);
  if (recusa) return recusa;

  // A decisão e a evidência andam juntas, e só existem para a resolução: um
  // corpo mal formado é recusado antes de qualquer leitura de ledger.
  if (acao === 'resolver-ambiguidade' && (!parsed.data.decisao || !parsed.data.evidencia)) {
    return negado('Resolver uma ambiguidade exige informar a decisão observada no Bling e a evidência.', 400);
  }

  const deps = criarManualOrderDependencies(scope);
  // A mesma montagem da criação (`ORBITA-<uuid>`), porque é essa a string que
  // foi gravada no ledger e enviada ao Bling em `numeroLoja`.
  const referenciaLocal = newLocalReference(parsed.data.referenciaLocal);

  const tentativa = await deps.store.lerTentativaPorReferencia(scope, referenciaLocal);
  if (tentativa === null) {
    // Não existe NESTA organização. Não distingue "nunca existiu" de "é de
    // outra organização" — distinguir revelaria a existência de uma tentativa
    // alheia.
    return negado('Não há nenhuma venda pendente com esta referência.', 404);
  }

  const elegibilidade = tentativaPodeSerReconciliada(tentativa, deps.now());
  if (!elegibilidade.pode) {
    return negado(elegibilidade.motivo, elegibilidade.status);
  }

  // O PODER, e não o nome da ação, decide o que esta conferência pode fazer.
  const poderes = { podeMutar: escopoTemCapacidade(scope, 'organization:manage') };
  const resolucao: ResolucaoPedida | undefined = parsed.data.decisao && parsed.data.evidencia
    ? { decisao: parsed.data.decisao, evidencia: parsed.data.evidencia }
    : undefined;

  return respostaDaReconciliacao(
    await reconciliarTentativa(scope, referenciaLocal, tentativa, deps, acao, poderes, resolucao),
  );
}
