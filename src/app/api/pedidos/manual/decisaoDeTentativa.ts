import type { NextResponse } from 'next/server';

import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import { respostaEstadoIndeterminado, respostaVendaJaRegistrada } from './compensacao';
import { falhaDaVendaManual } from './resposta';
import type { ReivindicacaoDeTentativa } from './ports';

/**
 * O que fazer com o resultado de reivindicar a referência de idempotência
 * (ticket 30, fatia 3).
 *
 * Separado de `handler.ts` porque virou uma responsabilidade própria: cada
 * rodada de revisão acrescentou um desfecho que **não** pode chamar o Bling, e
 * hoje são seis — só `TentativaNova` segue o fluxo normal.
 */

/**
 * Os desfechos que se resolvem só com uma mensagem e um status.
 *
 * Numa tabela, e não em seis `if`s quase idênticos: o que muda de um caso para
 * o outro é o texto, não a lógica, e o gate de qualidade sinalizou a
 * repetição. Cada mensagem diz **o que aconteceu** e **o que não aconteceu**
 * (nada foi enviado ao Bling), porque essa é a informação que evita a próxima
 * ação errada de quem está na tela.
 */
const RECUSAS: Readonly<Record<string, { readonly mensagem: string; readonly status: number }>> = {
  TentativaConflitante: {
    mensagem:
      'Esta submissão reutiliza a referência de uma venda diferente da que está sendo enviada agora. '
      + 'Por segurança, nada foi enviado ao Bling. Recarregue a tela para iniciar uma venda nova, '
      + 'ou reenvie exatamente a mesma venda da tentativa anterior.',
    status: 409,
  },
  TentativaComValoresDivergentes: {
    mensagem:
      'Os preços desta venda mudaram no cadastro desde a tentativa anterior, então ela NÃO foi reenviada '
      + 'ao Bling. Confira os valores e registre a venda de novo para confirmar o total atual.',
    status: 409,
  },
  TentativaComPendenciaIdentica: {
    mensagem:
      'Já existe uma venda igual a esta cujo resultado ainda não foi confirmado, e ela NÃO foi reenviada '
      + 'ao Bling. Confira a venda pendente primeiro: se ela não chegou a ser registrada, esta pode ser '
      + 'enviada em seguida.',
    status: 409,
  },
  TentativaEmAndamento: {
    mensagem:
      'Esta venda já está sendo registrada por outra requisição em andamento com a mesma referência. '
      + 'Aguarde a resposta dela antes de tentar de novo.',
    status: 409,
  },
};

/**
 * Segue com a tentativa nova, ou devolve a resposta pronta para um dos casos
 * em que a submissão NÃO deve chamar o Bling.
 *
 * Discriminado por `tentativaId` em vez de `NextResponse | null` de propósito —
 * assim o chamador estreita o tipo por um campo real, sem precisar de um `if`
 * inalcançável para satisfazer o TypeScript.
 */
export function decidirSobreTentativa(
  reivindicacao: ReivindicacaoDeTentativa,
): { readonly tentativaId: string; readonly epoca: number } | { readonly response: NextResponse } {
  if (reivindicacao._tag === 'TentativaNova') {
    return { tentativaId: reivindicacao.tentativaId, epoca: reivindicacao.epoca };
  }
  if (reivindicacao._tag === 'TentativaConcluida') {
    return { response: respostaVendaJaRegistrada(reivindicacao.pedidoId, reivindicacao.blingPedidoId) };
  }
  if (reivindicacao._tag === 'TentativaIndeterminada') {
    return { response: respostaEstadoIndeterminado(reivindicacao.blingPedidoId) };
  }
  if (reivindicacao._tag === 'TentativaIndisponivel') {
    // FAIL CLOSED (4ª rodada de revisão): a infraestrutura de idempotência não
    // respondeu — pode ser a migration 59 ainda não aplicada, pode ser uma
    // falha de transporte. Não importa qual: sem conseguir reivindicar a
    // referência, não há como garantir que uma retentativa não vai duplicar no
    // Bling, então a venda NÃO PROSSEGUE. A versão anterior tratava
    // "infraestrutura ausente" como "pode prosseguir sem a proteção" — essa
    // troca é exatamente o que a revisão apontou como perigosa.
    registrarFalhaInterna('pedidos.manual.tentativa.reivindicar', reivindicacao.causa);
    return {
      response: falhaDaVendaManual(
        'Não foi possível confirmar que esta venda ainda não foi registrada. Por segurança, ela NÃO foi '
          + 'enviada ao Bling. Tente novamente em instantes.',
        503,
      ),
    };
  }

  const recusa = RECUSAS[reivindicacao._tag];
  return { response: falhaDaVendaManual(recusa.mensagem, recusa.status) };
}
