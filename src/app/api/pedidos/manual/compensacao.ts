/**
 * O que fazer quando `persistVenda` não devolve sucesso (ticket 30, fatia 3).
 *
 * Separado de `handler.ts` para manter cada arquivo dentro do limite de
 * tamanho do gate de qualidade, e porque é uma responsabilidade distinta do
 * fluxo principal da venda — decidir SE e COMO reagir a uma falha de
 * persistência não é a mesma coisa que montar o pedido.
 */
import { NextResponse } from 'next/server';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import type { DesfechoDaTentativa, ManualOrderDependencies } from './ports';
import { falhaDaVendaManual as fail, jsonDaVendaManual as json } from './resposta';

/**
 * Resposta HTTP e desfecho da tentativa, juntos — o chamador (`handler.ts`)
 * precisa dos dois: a resposta vai para o cliente, o desfecho vai para
 * `registrarDesfechoDaTentativa` (ticket 30, fatia 3, 3ª rodada), para que a
 * PRÓXIMA reivindicação com a mesma `referenciaLocal` encontre um estado
 * terminal em vez de reexecutar o Bling. Devolver os dois juntos evita
 * reconstruir o desfecho reabrindo o corpo da resposta.
 */
export interface DesfechoDaFalha {
  readonly response: NextResponse;
  readonly desfecho: DesfechoDaTentativa;
}

/**
 * A resposta comum a todo caso em que a venda já existia: cancelar
 * (definitiva), confirmar (ambígua) e reivindicar uma referência já
 * concluída (ticket 30, fatia 3, 3ª rodada) chegam aqui pelo mesmo motivo —
 * a gravação aconteceu, só a certeza sobre ela é que demorou a chegar.
 */
export function respostaVendaJaRegistrada(
  pedidoId: string,
  blingPedidoId: string | null,
  /**
   * Avisos de efeitos que ainda pertenciam a esta requisição (10ª rodada de
   * revisão): quando a confirmação prova que o commit aconteceu, o lançamento
   * de estoque no ERP é feito aqui, e a falha dele precisa aparecer.
   */
  avisosExtras: readonly string[] = [],
): NextResponse {
  return json(
    {
      success: true,
      pedidoId,
      blingPedidoId,
      avisos: [
        'A venda já havia sido registrada numa tentativa anterior; nenhuma ação nova foi necessária.',
        ...avisosExtras,
      ],
    },
    200,
  );
}

/**
 * A resposta de estado indeterminado — nem "deu certo" nem "deu errado", e
 * por isso mesmo não pode disparar compensação nem permitir retentativa
 * automática. Compartilhada entre "a janela de confirmação se esgotou agora"
 * e "uma tentativa anterior com a mesma referência já ficou indeterminada".
 */
export function respostaEstadoIndeterminado(blingPedidoId: string | null): NextResponse {
  return fail(
    `Não foi possível confirmar se a venda foi registrada. A conexão com o banco foi perdida antes `
      + `de a resposta chegar${blingPedidoId ? `, e o pedido ${blingPedidoId} pode ou não existir no Bling e no ORBITA` : ''}. `
      + 'NÃO tente de novo e NÃO cancele o pedido no Bling agora: confira manualmente se a venda já '
      + 'existe no ORBITA antes de qualquer ação, para não duplicar nem apagar algo que já é real.',
    500,
    { blingPedidoId, estadoIndeterminado: true },
  );
}

/**
 * A resposta de quando a PRÓPRIA CRIAÇÃO no Bling ficou indeterminada
 * (ticket 30, fatia 3 — 5ª rodada de revisão).
 *
 * É pior do que a ambiguidade de persistência: aqui o ORBITA não tem sequer o
 * `bling_id`, então não há o que cancelar nem o que citar. O que existe é a
 * `referenciaLocal`, decidida ANTES do envio e enviada ao Bling em
 * `numeroLoja` — e é por ela que a reconciliação descobre, depois, se o
 * pedido existe. Por isso a mensagem manda conferir em vez de mandar repetir:
 * repetir é exatamente o que criaria o segundo pedido.
 */
export function respostaCriacaoNoBlingIndeterminada(): NextResponse {
  return fail(
    'Não foi possível confirmar se o pedido chegou a ser criado no Bling: a resposta não chegou. '
      + 'A venda NÃO foi registrada no ORBITA e esta tentativa ficou bloqueada de propósito — '
      + 'tentar de novo agora poderia criar um segundo pedido igual. '
      + 'Use a conferência desta venda para descobrir o que de fato aconteceu antes de qualquer nova ação.',
    500,
    { estadoIndeterminado: true, blingPedidoId: null },
  );
}

/**
 * Desfaz no Bling a venda que o ORBITA não conseguiu gravar.
 *
 * O efeito remoto acontece ANTES da gravação local, e não há como inverter a
 * ordem: o `bling_id` do pedido só existe depois da criação remota. A única
 * saída honesta é compensar — cancelar lá o que não existe aqui.
 *
 * Sem isto, cada tentativa deixava um pedido órfão na conta real do lojista.
 * Aconteceu em 2026-08-30: o pedido 26735607230 nasceu no Bling, a gravação
 * local foi recusada pelo banco, e ele ficou sem par no ORBITA. Não havia
 * retentativa segura — tentar de novo criava mais um.
 *
 * **Só é chamada para `PersistVendaFalhouDefinitivamente`** (ticket 30, fatia
 * 3) — um erro estruturado que o servidor devolveu depois de terminar de
 * processar a requisição. Uma resposta assim só existe depois que a
 * transação já foi revertida: não há ambiguidade para resolver aqui, e por
 * isso é seguro compensar direto. `PersistVendaAmbigua` (a chamada falhou
 * sem resposta do servidor — timeout, conexão perdida) vai para
 * `resolverAmbiguidadeDePersistencia`, que **não** compensa sem confirmar.
 *
 * A checagem abaixo é defesa a mais, não o que decide se compensa: mesmo numa
 * falha definitiva, nada impede uma tentativa concorrente (ou uma reentrega)
 * de ter registrado a mesma venda entre o erro e este ponto.
 *
 * ---
 *
 * **A máquina de estados completa da fatia 3 (4ª rodada de revisão).** O
 * erro que a revisão apontou: "falha definitiva" na persistência local NÃO
 * significa "nada ficou pendente no Bling" — só significa que a GRAVAÇÃO
 * LOCAL não vai acontecer. O Bling é uma chamada separada, com seu PRÓPRIO
 * resultado, que pode ele mesmo ser confirmado ou ambíguo. A tabela:
 *
 * | Persistência local | Compensação no Bling | `estado` gravado | Uma retentativa com a MESMA referência pode... |
 * |---|---|---|---|
 * | `PersistVendaOk` | (não se aplica) | `concluida` | reutilizar o resultado — nunca chama o Bling de novo |
 * | `PersistVendaFalhouDefinitivamente`, sem `blingPedidoId` | (nada a compensar) | `falhou` | ser aberta — nada foi criado no Bling |
 * | `PersistVendaFalhouDefinitivamente`, achou venda já registrada | (não precisou compensar) | `concluida` | reutilizar o resultado |
 * | `PersistVendaFalhouDefinitivamente` | **confirmada** (`compensado: true`) | `falhou` | ser aberta — o Bling está confirmadamente limpo |
 * | `PersistVendaFalhouDefinitivamente` | **falhou/ambígua** (`compensado: false`) | **`indeterminada`** | **NÃO** — o Bling pode ter um pedido pendente que ninguém confirmou cancelado |
 * | `PersistVendaAmbigua`, confirmação achou a venda | (não se aplica) | `concluida` | reutilizar o resultado |
 * | `PersistVendaAmbigua`, confirmação nunca resolveu | (não tentou compensar) | `indeterminada` | **NÃO** — não se sabe se a venda existe |
 *
 * A linha que a revisão pegou: a versão anterior gravava `'falhou'` também
 * quando a compensação falhava — como se "a persistência falhou" bastasse
 * para saber que "nada ficou pendente no Bling". Só uma compensação
 * CONFIRMADA prova isso. `'indeterminada'` é o estado certo para "não sei",
 * e é exatamente o estado que a reivindicação de uma retentativa já trata
 * como bloqueante — reaproveitar esse estado, em vez de inventar um quinto,
 * mantém a máquina pequena.
 */
export async function compensarNoBling(
  scope: VerifiedOrganizationScope,
  blingPedidoId: string | null,
  error: unknown,
  deps: ManualOrderDependencies,
): Promise<DesfechoDaFalha> {
  // Ticket 22, critério 13 — `causa` é `descreverErro` do erro do banco, e ela
  // ia inteira para o cliente. Não ajuda a reconciliar nada e é diagnóstico
  // interno (CWE-209): passa a ficar só no log. O que permite agir — o id do
  // pedido no Bling e a instrução — continua na resposta.
  registrarFalhaInterna('pedidos.manual.registrar', error);

  if (blingPedidoId === null) {
    // Nada foi criado no Bling: não há o que reconciliar, e não há o que dizer
    // além de que falhou.
    return { response: fail(MENSAGEM_PUBLICA_DE_FALHA, 500, { blingPedidoId }), desfecho: { estado: 'falhou' } };
  }

  const jaRegistrada = await deps.store.findVendaManualJaRegistrada(scope, blingPedidoId);
  if (jaRegistrada !== null) {
    return {
      response: respostaVendaJaRegistrada(jaRegistrada.pedidoId, blingPedidoId),
      desfecho: { estado: 'concluida', pedidoId: jaRegistrada.pedidoId, blingPedidoId },
    };
  }

  const compensacao = await deps.bling.cancelarPedidoVenda(blingPedidoId);
  if (compensacao._tag === 'BlingFailed') {
    // As duas metades falharam. É o único caminho que exige ação humana, e por
    // isso ele diz exatamente o quê, onde e por quê.
    return {
      response: fail(
        `Falha ao registrar a venda no ORBITA. O pedido ${blingPedidoId} foi criado no Bling e o `
          // A razão vem do **Bling**, não daqui: é ela que diz por que o
          // cancelamento automático não funcionou, e é o que a pessoa precisa
          // saber para resolver à mão. Mensagem de provedor externo não é
          // diagnóstico interno, e sai de propósito.
          + `cancelamento automático também falhou (${compensacao.failure.message}). `
          + 'Cancele o pedido no Bling antes de tentar de novo, senão a próxima tentativa cria outro.',
        500,
        { blingPedidoId, compensado: false },
      ),
      // MÁQUINA DE ESTADOS (4ª rodada de revisão) — 'falhou' só é seguro
      // quando o Bling está CONFIRMADAMENTE limpo. Aqui não está: a
      // compensação em si falhou, então o pedido pode continuar existindo lá.
      // 'indeterminada', não 'falhou' — bloqueia a referência exatamente como
      // uma ambiguidade de persistência bloqueia, até alguém confirmar à mão
      // (cancelar no Bling) e destravar manualmente. Reabrir aqui deixaria
      // uma retentativa criar um SEGUNDO pedido em cima de um primeiro que
      // ninguém confirmou estar cancelado.
      desfecho: { estado: 'indeterminada', blingPedidoId },
    };
  }

  return {
    response: fail(
      `Falha ao registrar a venda no ORBITA. O pedido ${blingPedidoId} foi cancelado no Bling `
        + 'automaticamente, então nada ficou pendente lá. Pode tentar de novo.',
      500,
      { blingPedidoId, compensado: true },
    ),
    desfecho: { estado: 'falhou', blingPedidoId },
  };
}

/**
 * Janelas de espera entre tentativas de confirmar uma `PersistVendaAmbigua`.
 *
 * A primeira tentativa é imediata (fecha o caso mais comum: o commit já
 * aconteceu, só a resposta se perdeu). As seguintes dão tempo para uma
 * transação que ainda estava em voo no momento do erro terminar — commitando
 * ou revertendo — antes de decidir. Soma pouco mais de 2.5s: o bastante para
 * uma chamada de banco que normalmente leva dezenas de milissegundos, curto o
 * bastante para não prender a requisição indefinidamente.
 */
const JANELAS_DE_CONFIRMACAO_MS: readonly number[] = [0, 400, 800, 1600];

/**
 * Tenta confirmar, repetidamente, se a venda foi registrada — para o caso em
 * que a falha original não teve resposta estruturada do servidor (ticket 30,
 * fatia 3).
 *
 * Uma única leitura logo após o erro não prova ausência: se a transação
 * ainda estava em voo no instante do erro, ela pode commitar milissegundos
 * depois — e uma leitura que rodou ANTES desse commit veria "não existe" sem
 * que isso signifique que a venda falhou. É a mesma forma de erro do
 * `completeJob`: "não encontrei ainda" não é "não foi persistido".
 *
 * @returns O pedido, se a confirmação achá-lo em qualquer tentativa; `null`
 *          se todas as janelas se esgotarem sem achar.
 */
async function confirmarVendaComRetentativa(
  scope: VerifiedOrganizationScope,
  blingPedidoId: string,
  deps: ManualOrderDependencies,
): Promise<{ readonly pedidoId: string } | null> {
  for (const espera of JANELAS_DE_CONFIRMACAO_MS) {
    if (espera > 0) await deps.dormir(espera);
    try {
      const achada = await deps.store.findVendaManualJaRegistrada(scope, blingPedidoId);
      if (achada !== null) return achada;
    } catch {
      // A própria checagem pode falhar por transporte — é a mesma classe de
      // ambiguidade que trouxe a gente até aqui. Não é motivo para desistir
      // da janela de confirmação, só para tentar de novo na próxima.
    }
  }
  return null;
}

/**
 * Resolve uma `PersistVendaAmbigua`: a chamada de `persistVenda` falhou sem
 * resposta estruturada do servidor — não há como saber, só por isso, se a
 * transação chegou a commitar.
 *
 * **Nunca compensa aqui.** Cancelar no Bling depois de uma janela de
 * confirmação que não achou a venda ainda seria uma aposta: a transação pode
 * commitar um instante depois da última tentativa de confirmação. A saída
 * honesta é recusar a decisão automática e dizer isso claramente — não
 * "tentou compensar e falhou", e sim "não dá para saber, não aja sozinho".
 *
 * O `desfecho` devolvido quando a ambiguidade não se resolve é `indeterminada`
 * — é o que fecha o ciclo (ticket 30, fatia 3, 3ª rodada): a PRÓXIMA
 * reivindicação com a mesma `referenciaLocal` encontra esse estado e devolve
 * `respostaEstadoIndeterminado` de novo, sem chamar o Bling.
 */
export async function resolverAmbiguidadeDePersistencia(
  scope: VerifiedOrganizationScope,
  blingPedidoId: string | null,
  error: unknown,
  deps: ManualOrderDependencies,
): Promise<DesfechoDaFalha> {
  registrarFalhaInterna('pedidos.manual.registrar.ambiguo', error);

  if (blingPedidoId === null) {
    // Sem sincronização não há o que compensar no Bling — mas a ambiguidade
    // sobre a gravação local continua, e a mensagem não pode fingir certeza.
    return { response: fail(MENSAGEM_PUBLICA_DE_FALHA, 500, { blingPedidoId }), desfecho: { estado: 'indeterminada' } };
  }

  const jaRegistrada = await confirmarVendaComRetentativa(scope, blingPedidoId, deps);
  if (jaRegistrada !== null) {
    return {
      response: respostaVendaJaRegistrada(jaRegistrada.pedidoId, blingPedidoId),
      desfecho: { estado: 'concluida', pedidoId: jaRegistrada.pedidoId, blingPedidoId },
    };
  }

  return {
    response: respostaEstadoIndeterminado(blingPedidoId),
    desfecho: { estado: 'indeterminada', blingPedidoId },
  };
}
