/**
 * A POSSE da tentativa, e o que ela autoriza (ticket 30 — 9ª rodada de revisão).
 *
 * Separado de `handler.ts` porque é uma responsabilidade própria: decidir se
 * este executor ainda pode produzir efeito não é a mesma coisa que montar e
 * enviar a venda. E porque `handler.ts` passou do limite de tamanho do gate de
 * qualidade quando o fencing dos efeitos comerciais entrou.
 */
import type { NextResponse } from 'next/server';

import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type { ManualOrderDependencies } from './ports';
import { falhaDaVendaManual as fail } from './resposta';

/**
 * A tentativa que este executor reivindicou, e a época em que a reivindicou.
 *
 * Viaja junto em todo o fluxo desde a 9ª rodada de revisão: é o token de posse
 * que autoriza cada efeito — externo (B2) e local (B1).
 */
export interface PosseDaVenda {
  readonly tentativaId: string;
  readonly epoca: number;
}

/**
 * Confere a posse imediatamente antes de um efeito externo (9ª rodada, B2).
 *
 * Falha fechada: não conseguir perguntar conta como "não sou dono". A
 * alternativa — seguir e chamar o ERP mesmo assim — é exatamente o efeito
 * zumbi que esta rodada existe para fechar.
 */
export async function posseAindaVigente(
  scope: VerifiedOrganizationScope,
  posse: PosseDaVenda,
  etapa: string,
  deps: ManualOrderDependencies,
): Promise<boolean> {
  const atual = await deps.store.confirmarPosse(scope, posse.tentativaId, posse.epoca);
  if (atual._tag === 'PosseVigente') return true;
  if (atual._tag === 'PosseIndeterminada') {
    registrarFalhaInterna(`pedidos.manual.posse.${etapa}`, atual.causa);
  }
  return false;
}

/** A resposta de quem perdeu a posse: nada foi feito, e nada foi registrado. */
export function respostaPosseTomada(): NextResponse {
  return fail(
    'Esta venda foi assumida por uma conferência enquanto era processada, então esta requisição '
      + 'NÃO gravou nada e NÃO deve ser repetida. Consulte a situação atual desta venda pela conferência '
      + 'antes de qualquer nova ação.',
    409,
  );
}

/**
 * A resposta de "o efeito aconteceu e o registro não" (9ª rodada, B4).
 *
 * Nenhuma resposta de sucesso sem o estado durável correspondente. A venda
 * pode existir; o que NÃO existe é a garantia de idempotência que um `2xx`
 * afirmaria. Repetir daqui é o que criaria a segunda venda, então a mensagem
 * manda conferir, não repetir.
 */
export function respostaLedgerNaoGravado(blingPedidoId: string | null): NextResponse {
  return fail(
    'A venda pode ter sido registrada, mas o ORBITA não conseguiu gravar o controle que impede '
      + 'uma duplicação. NÃO tente de novo: use a conferência desta venda para descobrir a situação real '
      + 'antes de qualquer nova ação.',
    500,
    { blingPedidoId, estadoIndeterminado: true },
  );
}
