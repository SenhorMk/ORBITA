import { NextResponse } from 'next/server';

import type { ResultadoDaReconciliacao } from './reconciliacao';

/**
 * As respostas HTTP da reconciliação, numa tabela só.
 *
 * Cada desfecho da máquina tem uma resposta própria, e o que distingue umas
 * das outras é justamente o que a revisão vem cobrando: **quando a referência
 * é liberada e quando não é**. Numa tabela, essa comparação fica visível de
 * uma vez — em vez de espalhada por sete `if`s quase iguais, que era o que o
 * gate de qualidade sinalizava como bloco duplicado.
 */

/** Corpo de resposta de `POST /api/pedidos/manual/reconciliar`. */
export interface RespostaDaReconciliacao {
  readonly success: boolean;
  /** `true` quando a referência foi liberada e o cliente pode esquecê-la. */
  readonly referenciaLiberada: boolean;
  readonly situacao:
    | 'nenhum_pedido_visivel'
    | 'encerrada_como_nao_criada'
    | 'venda_confirmada'
    | 'venda_confirmada_sem_registro'
    | 'ambiguidade_resolvida'
    | 'pendente_no_bling'
    | 'cancelado_no_bling'
    | 'cancelamento_ambiguo'
    | 'nao_reconciliavel';
  readonly mensagem: string;
  readonly pedidoId?: string;
  readonly blingPedidoId?: string;
}

/** O que cada desfecho vira, do ponto de vista de quem está na tela. */
interface Apresentacao {
  readonly situacao: RespostaDaReconciliacao['situacao'];
  readonly status: number;
  /** Liberar significa: o cliente pode esquecer a referência e vender de novo. */
  readonly liberada: boolean;
  readonly mensagem: (blingPedidoId: string) => string;
}

const APRESENTACOES: Readonly<Record<string, Apresentacao>> = {
  NenhumPedidoVisivel: {
    situacao: 'nenhum_pedido_visivel',
    status: 409,
    liberada: false,
    mensagem: () =>
      'A consulta ao Bling não encontrou nenhum pedido com esta referência — mas isso NÃO prova que ele '
      + 'não foi criado: o Bling não garante que um pedido recém-criado apareça imediatamente na listagem. '
      + 'A venda continua bloqueada. Confira no Bling e, se confirmar que o pedido não existe, encerre '
      + 'esta tentativa explicitamente.',
  },
  EncerradaComoNaoCriada: {
    situacao: 'encerrada_como_nao_criada',
    status: 200,
    liberada: true,
    mensagem: () =>
      'Tentativa encerrada como não realizada, por conferência manual. A venda pode ser registrada de novo.',
  },
  VendaConfirmada: {
    situacao: 'venda_confirmada',
    status: 200,
    liberada: true,
    mensagem: () => 'Conferido no Bling: a venda foi registrada nos dois lados. Só a confirmação tinha se perdido.',
  },
  VendaConfirmadaSemRegistro: {
    situacao: 'venda_confirmada_sem_registro',
    status: 200,
    // NÃO libera: quem inspecionou não tem gestão, então nada foi gravado. A
    // resposta relata o que foi observado sem afirmar um efeito que não houve.
    liberada: false,
    mensagem: () =>
      'Conferido no Bling: a venda existe nos dois lados. Como esta conta não administra a organização, '
      + 'nada foi registrado e a referência continua bloqueada. Peça a conferência a um administrador '
      + 'para liberá-la.',
  },
  PendenteNoBling: {
    situacao: 'pendente_no_bling',
    status: 409,
    liberada: false,
    mensagem: (id) =>
      `Conferido no Bling: o pedido ${id} existe lá, mas a venda não foi gravada no ORBITA. `
      + 'Esta tentativa continua bloqueada de propósito. Para encerrá-la, peça o cancelamento do pedido no '
      + 'Bling — é uma ação explícita, e não acontece por conferência.',
  },
  CanceladoNoBling: {
    situacao: 'cancelado_no_bling',
    status: 200,
    liberada: true,
    mensagem: (id) =>
      `O pedido ${id} foi cancelado no Bling e nada ficou pendente lá. Esta venda pode ser registrada de novo.`,
  },
  CancelamentoAmbiguo: {
    situacao: 'cancelamento_ambiguo',
    status: 409,
    liberada: false,
    mensagem: (id) =>
      `O cancelamento do pedido ${id} foi enviado ao Bling, mas a resposta não chegou — ele pode ou não ter `
      + 'sido cancelado. Confira a situação do pedido diretamente no Bling. Esta venda continua bloqueada e '
      + 'NÃO deve ter o cancelamento repetido daqui.',
  },
};

/** Traduz o desfecho da reconciliação para a resposta HTTP. */
export function respostaDaReconciliacao(resultado: ResultadoDaReconciliacao): NextResponse {
  if (resultado._tag === 'NaoReconciliavel') {
    return NextResponse.json(
      {
        success: false,
        referenciaLiberada: false,
        situacao: 'nao_reconciliavel',
        mensagem: resultado.motivo,
      } satisfies RespostaDaReconciliacao,
      { status: resultado.status },
    );
  }

  // A resolução da ambiguidade é o único desfecho cuja liberação depende da
  // DECISÃO registrada, não do seu tipo: `cancelado` prova que nada ficou
  // pendente no ERP e libera; `nao-cancelado` mantém o bloqueio e só devolve o
  // claim, para que um novo cancelamento possa ser reivindicado.
  if (resultado._tag === 'AmbiguidadeResolvida') {
    return NextResponse.json(
      {
        success: true,
        referenciaLiberada: resultado.liberou,
        situacao: 'ambiguidade_resolvida',
        mensagem: resultado.liberou
          ? 'Decisão registrada: o pedido está cancelado no Bling. Nada ficou pendente lá, e esta venda '
            + 'pode ser registrada de novo.'
          : 'Decisão registrada: o pedido continua ativo no Bling. A venda segue bloqueada, mas o '
            + 'cancelamento pode ser pedido de novo agora.',
      } satisfies RespostaDaReconciliacao,
      { status: 200 },
    );
  }

  const apresentacao = APRESENTACOES[resultado._tag];
  const blingPedidoId = 'blingPedidoId' in resultado ? resultado.blingPedidoId : undefined;

  return NextResponse.json(
    {
      success: apresentacao.liberada,
      referenciaLiberada: apresentacao.liberada,
      situacao: apresentacao.situacao,
      mensagem: apresentacao.mensagem(blingPedidoId ?? ''),
      ...('pedidoId' in resultado ? { pedidoId: resultado.pedidoId } : {}),
      ...(blingPedidoId ? { blingPedidoId } : {}),
    } satisfies RespostaDaReconciliacao,
    { status: apresentacao.status },
  );
}
