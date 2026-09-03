import { NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';

import { criarManualOrderDependencies, newLocalReference } from '../dependencias';
import { reconciliarTentativa, respostaDaReconciliacao, tentativaPodeSerReconciliada } from '../reconciliacao';

/**
 * `POST /api/pedidos/manual/reconciliar` — o caminho de saída de uma tentativa
 * de venda manual que ficou indeterminada (ticket 30, fatia 3 — 5ª rodada de
 * revisão).
 *
 * Bloquear uma tentativa cujo desfecho ninguém confirmou é o comportamento
 * seguro; sem esta rota, seria também um beco sem saída, cuja única "solução"
 * seria apagar a chave de idempotência do navegador — ou seja, furar
 * exatamente a proteção contra duplicação. Ver `reconciliacao.ts` para a
 * máquina de estados e para como se pergunta ao Bling sem ter o `bling_id`.
 *
 * **Escrita no ERP só sob pedido explícito.** O padrão (`acao: 'conferir'`) é
 * exclusivamente leitura. `acao: 'cancelar-no-bling'` é a intervenção
 * operacional do 6º ponto da revisão — existe para que o desfecho "o pedido
 * existe no Bling e a venda não existe aqui" tenha um terminal, em vez de
 * ficar bloqueado para sempre —, e nunca acontece por conferência.
 */
const corpoSchema = z.object({
  /** O UUID que o cliente guardou; a rota o converte na referência completa. */
  referenciaLocal: z.string().uuid('referenciaLocal precisa ser um UUID'),
  /**
   * `'conferir'` (padrão) é só leitura. `'cancelar-no-bling'` ESCREVE no ERP e
   * por isso precisa ser pedida nomeadamente — é a intervenção explícita para
   * o caso "o pedido existe no Bling e a venda não existe aqui", que a
   * conferência sozinha não resolve (6ª rodada de revisão).
   */
  acao: z.enum(['conferir', 'cancelar-no-bling']).default('conferir'),
});

export async function POST(request: Request): Promise<NextResponse> {
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
  const { scope } = scopeResult;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Corpo da requisição não é um JSON válido.' }, { status: 400 });
  }

  const parsed = corpoSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Referência da venda inválida.' }, { status: 400 });
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
    return NextResponse.json(
      { success: false, error: 'Não há nenhuma venda pendente com esta referência.' },
      { status: 404 },
    );
  }

  const elegibilidade = tentativaPodeSerReconciliada(tentativa, deps.now());
  if (!elegibilidade.pode) {
    return NextResponse.json({ success: false, error: elegibilidade.motivo }, { status: elegibilidade.status });
  }

  return respostaDaReconciliacao(
    await reconciliarTentativa(scope, referenciaLocal, tentativa, deps, parsed.data.acao),
  );
}
