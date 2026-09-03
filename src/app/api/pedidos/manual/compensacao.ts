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

import type { ManualOrderDependencies, ManualOrderResponseBody } from './ports';

function json(body: ManualOrderResponseBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

function fail(error: string, status: number, extra: Partial<ManualOrderResponseBody> = {}): NextResponse {
  return json({ success: false, error, ...extra }, status);
}

/**
 * A resposta comum aos dois casos em que a venda já existia: cancelar
 * (definitiva) e confirmar (ambígua) chegam aqui pelo mesmo motivo — a
 * gravação aconteceu, só a certeza sobre ela é que demorou a chegar.
 */
function respostaVendaJaRegistrada(pedidoId: string, blingPedidoId: string): NextResponse {
  return json(
    {
      success: true,
      pedidoId,
      blingPedidoId,
      avisos: ['A venda já havia sido registrada numa tentativa anterior; nenhuma ação nova foi necessária.'],
    },
    200,
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
 */
export async function compensarNoBling(
  scope: VerifiedOrganizationScope,
  blingPedidoId: string | null,
  error: unknown,
  deps: ManualOrderDependencies,
): Promise<NextResponse> {
  // Ticket 22, critério 13 — `causa` é `descreverErro` do erro do banco, e ela
  // ia inteira para o cliente. Não ajuda a reconciliar nada e é diagnóstico
  // interno (CWE-209): passa a ficar só no log. O que permite agir — o id do
  // pedido no Bling e a instrução — continua na resposta.
  registrarFalhaInterna('pedidos.manual.registrar', error);

  if (blingPedidoId === null) {
    // Nada foi criado no Bling: não há o que reconciliar, e não há o que dizer
    // além de que falhou.
    return fail(MENSAGEM_PUBLICA_DE_FALHA, 500, { blingPedidoId });
  }

  const jaRegistrada = await deps.store.findVendaManualJaRegistrada(scope, blingPedidoId);
  if (jaRegistrada !== null) {
    return respostaVendaJaRegistrada(jaRegistrada.pedidoId, blingPedidoId);
  }

  const compensacao = await deps.bling.cancelarPedidoVenda(blingPedidoId);
  if (compensacao._tag === 'BlingFailed') {
    // As duas metades falharam. É o único caminho que exige ação humana, e por
    // isso ele diz exatamente o quê, onde e por quê.
    return fail(
      `Falha ao registrar a venda no ORBITA. O pedido ${blingPedidoId} foi criado no Bling e o `
        // A razão vem do **Bling**, não daqui: é ela que diz por que o
        // cancelamento automático não funcionou, e é o que a pessoa precisa
        // saber para resolver à mão. Mensagem de provedor externo não é
        // diagnóstico interno, e sai de propósito.
        + `cancelamento automático também falhou (${compensacao.failure.message}). `
        + 'Cancele o pedido no Bling antes de tentar de novo, senão a próxima tentativa cria outro.',
      500,
      { blingPedidoId, compensado: false },
    );
  }

  return fail(
    `Falha ao registrar a venda no ORBITA. O pedido ${blingPedidoId} foi cancelado no Bling `
      + 'automaticamente, então nada ficou pendente lá. Pode tentar de novo.',
    500,
    { blingPedidoId, compensado: true },
  );
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
 * honesta, sem um mecanismo de idempotência mais forte (chave de tentativa
 * persistida, reconciliação assíncrona), é recusar a decisão automática e
 * dizer isso claramente — não "tentou compensar e falhou", e sim "não dá para
 * saber, não aja sozinho".
 */
export async function resolverAmbiguidadeDePersistencia(
  scope: VerifiedOrganizationScope,
  blingPedidoId: string | null,
  error: unknown,
  deps: ManualOrderDependencies,
): Promise<NextResponse> {
  registrarFalhaInterna('pedidos.manual.registrar.ambiguo', error);

  if (blingPedidoId === null) {
    // Sem sincronização não há o que compensar no Bling — mas a ambiguidade
    // sobre a gravação local continua, e a mensagem não pode fingir certeza.
    return fail(MENSAGEM_PUBLICA_DE_FALHA, 500, { blingPedidoId });
  }

  const jaRegistrada = await confirmarVendaComRetentativa(scope, blingPedidoId, deps);
  if (jaRegistrada !== null) {
    return respostaVendaJaRegistrada(jaRegistrada.pedidoId, blingPedidoId);
  }

  return fail(
    `Não foi possível confirmar se a venda foi registrada. A conexão com o banco foi perdida antes `
      + `de a resposta chegar, e o pedido ${blingPedidoId} pode ou não existir no Bling e no ORBITA. `
      + 'NÃO tente de novo e NÃO cancele o pedido no Bling agora: confira manualmente se a venda já '
      + 'existe no ORBITA antes de qualquer ação, para não duplicar nem apagar algo que já é real.',
    500,
    { blingPedidoId, estadoIndeterminado: true },
  );
}
