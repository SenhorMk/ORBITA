import type { NextResponse } from 'next/server';

import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import { respostaEstadoIndeterminado, respostaVendaJaRegistrada } from './compensacao';
import { falhaDaVendaManual } from './resposta';
import type { ReivindicacaoDeTentativa } from './ports';

/**
 * O que fazer com o resultado de reivindicar a referência de idempotência.
 *
 * A reivindicação tem oito desfechos, e só `TentativaNova` segue o fluxo normal
 * até o Bling. Os demais — já concluída, indeterminada, conflito de conteúdo,
 * valores divergentes, pendência idêntica, em andamento, infraestrutura
 * indisponível — devolvem uma resposta pronta sem chamar o Bling.
 */

/**
 * Os desfechos que se resolvem só com uma mensagem e um status.
 *
 * Numa tabela, e não em `if`s quase idênticos: o que muda de um caso para o
 * outro é o texto, não a lógica. Cada mensagem diz **o que aconteceu** e **o que não aconteceu**
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
    // FAIL CLOSED: a infraestrutura de idempotência não respondeu — pode ser
    // a migration 59 ainda não aplicada, pode ser uma falha de transporte. Sem
    // conseguir reivindicar a referência, nada impede uma retentativa de
    // duplicar no Bling, então a venda NÃO PROSSEGUE. Prosseguir "sem a
    // proteção" desligaria a proteção em silêncio.
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
