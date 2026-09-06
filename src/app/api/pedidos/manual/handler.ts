import { NextResponse } from 'next/server';

import { type ManualOrderRequest } from '@/lib/config/manualOrderContract';
import { fingerprintDaVendaManual, fingerprintDosValoresResolvidos } from '@/lib/config/manualOrderFingerprint';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import {
  compensarNoBling,
  resolverAmbiguidadeDePersistencia,
  respostaCriacaoNoBlingIndeterminada,
} from './compensacao';
import { classificarFalhaDeCriacaoNoBling } from './classificacaoDeFalhaBling';
import { decidirSobreTentativa } from './decisaoDeTentativa';
import { prepararEnvioAoBling, toBlingDate, type EntradaDoEnvio } from './envioAoBling';
import { prepararPedido } from './preparacao';
import {
  posseAindaVigente,
  respostaLedgerNaoGravado,
  respostaPosseTomada,
  type PosseDaVenda,
} from './posseDaVenda';
import { falhaDaVendaManual as fail, jsonDaVendaManual as json } from './resposta';
import type { ManualOrderCliente, ManualOrderDependencies } from './ports';

export * from './ports';
export { compensarNoBling, resolverAmbiguidadeDePersistencia } from './compensacao';

/**
 * Desfecho da sincronização com o Bling. Três casos, não dois (5ª rodada de
 * revisão): `SyncRejected` e `SyncIndeterminado` exigem reações OPOSTAS no
 * ledger de idempotência.
 *
 * - `SyncRejected` — nada foi criado no Bling, e isso é **sabido**: a falha
 *   aconteceu antes do envio (contato, forma de pagamento, payload inválido)
 *   ou o Bling respondeu recusando. A tentativa pode ficar `falhou`, que é
 *   REABRÍVEL — retentar é seguro.
 * - `SyncIndeterminado` — o `POST /pedidos/vendas` foi despachado e o desfecho
 *   é desconhecido: timeout, conexão perdida, `5xx`, ou sucesso com id
 *   ilegível. O pedido pode existir na conta do lojista, e o ORBITA pode nem
 *   saber o `bling_id`. A tentativa fica `indeterminada`, que BLOQUEIA a
 *   referência — retentar criaria um segundo pedido real.
 */
type SyncResult =
  | { readonly _tag: 'Synced'; readonly blingPedidoId: string; readonly avisos: readonly string[] }
  | { readonly _tag: 'SyncRejected'; readonly response: NextResponse }
  | { readonly _tag: 'SyncIndeterminado'; readonly causa: unknown }
  /**
   * A posse da tentativa mudou (9ª rodada de revisão, B2). Nenhum efeito
   * externo NOVO é iniciado a partir daqui, e o ledger não é tocado: quem tomou
   * a posse é quem decide o desfecho.
   */
  | { readonly _tag: 'SyncSemPosse' };

/**
 * Cria o pedido no Bling e lança o estoque vinculado a ele.
 *
 * A falha da baixa de estoque acontece depois de o pedido já existir no ERP,
 * então ela vira aviso — não pode derrubar a venda nem ser engolida.
 */
async function sincronizarComBling(
  scope: VerifiedOrganizationScope,
  cliente: ManualOrderCliente,
  body: ManualOrderRequest,
  entrada: EntradaDoEnvio,
  posse: PosseDaVenda,
  deps: ManualOrderDependencies,
): Promise<SyncResult> {
  const payloadResult = await prepararEnvioAoBling(scope, cliente, body, entrada, deps);
  if (payloadResult._tag === 'PayloadRejected') {
    return { _tag: 'SyncRejected', response: payloadResult.response };
  }

  // A PARTIR DAQUI o pedido pode existir no Bling (5ª rodada de revisão).
  // Uma exceção lançada aqui — timeout, conexão perdida, abort — não prova
  // que nada foi criado: prova só que a RESPOSTA não chegou. Deixá-la subir
  // marcaria a tentativa como `falhou` (reabrível) ou a deixaria presa em
  // `em_andamento` para sempre; as duas coisas estão erradas.
  //
  // FENCING DO EFEITO COMERCIAL (9ª rodada de revisão, B2). Antes desta
  // rodada, um executor que já tinha perdido a posse ainda podia criar o
  // pedido no ERP. A pergunta é feita aqui, o mais tarde possível antes do
  // envio.
  if (!await posseAindaVigente(scope, posse, 'criar', deps)) {
    return { _tag: 'SyncSemPosse' };
  }

  let criado: Awaited<ReturnType<ManualOrderDependencies['bling']['createPedidoVenda']>>;
  try {
    criado = await deps.bling.createPedidoVenda(payloadResult.payload);
  } catch (causa) {
    return { _tag: 'SyncIndeterminado', causa };
  }

  if (criado._tag === 'BlingFailed') {
    if (classificarFalhaDeCriacaoNoBling(criado.failure) === 'Ambigua') {
      return { _tag: 'SyncIndeterminado', causa: new Error(criado.failure.message) };
    }
    return {
      _tag: 'SyncRejected',
      response: fail(`O Bling recusou o pedido: ${criado.failure.message}`, 400, {
        vendaDuplicada: criado.failure.duplicateSale,
      }),
    };
  }

  const blingPedidoId = criado.value.id;
  const avisos = criado.value.alertas.map((alerta) => `Bling: ${alerta}`);

  // A posse pode ter mudado ENTRE a criação e a baixa (9ª rodada, B2): lançar
  // estoque de um pedido que a nova dona pode estar cancelando é justamente o
  // efeito incompatível a evitar. O pedido criado não fica perdido — ele
  // carrega a `referenciaLocal` em `numeroLoja`, que é como a reconciliação o
  // encontra.
  if (!await posseAindaVigente(scope, posse, 'estoque', deps)) {
    return { _tag: 'SyncSemPosse' };
  }

  const estoque = await deps.bling.lancarEstoquePedido(blingPedidoId);
  if (estoque._tag === 'BlingFailed') {
    avisos.push(
      `O pedido ${blingPedidoId} foi criado no Bling, mas a baixa de estoque no ERP falhou: ${estoque.failure.message}. Confira o estoque no Bling.`,
    );
  }

  return { _tag: 'Synced', blingPedidoId, avisos };
}

/**
 * Registra o desfecho da tentativa quando a sincronização com o Bling não
 * produziu um pedido, e devolve a resposta pronta. `null` significa "seguiu
 * bem, continue".
 *
 * Os dois desfechos exigem reações OPOSTAS no ledger, e é por isso que estão
 * juntos aqui em vez de espalhados: `SyncRejected` grava `falhou`
 * (REABRÍVEL — a recusa foi comprovada pelo contrato do Bling, então nada
 * existe lá); `SyncIndeterminado` grava `indeterminada` (BLOQUEIA — o pedido
 * pode existir, e sem `bling_id` não há o que cancelar nem o que gravar).
 */
async function recusaDaSincronizacao(
  sync: SyncResult,
  scope: VerifiedOrganizationScope,
  posse: PosseDaVenda,
  deps: ManualOrderDependencies,
): Promise<NextResponse | null> {
  const { tentativaId, epoca } = posse;
  // Perdeu a posse: NÃO escreve no ledger. Quem tomou a posse é quem decide o
  // desfecho, e gravar daqui seria escrever por cima de uma decisão alheia —
  // o defeito que o fencing existe para impedir (9ª rodada, B2).
  if (sync._tag === 'SyncSemPosse') {
    return respostaPosseTomada();
  }
  if (sync._tag === 'SyncRejected') {
    // Nada existe em lugar nenhum (o Bling recusou por contrato). Se o ledger
    // não gravar, a tentativa segue `em_andamento` e BLOQUEIA a referência até
    // uma conferência — bloqueio a mais, nunca sucesso a mais.
    await deps.store.registrarDesfechoDaTentativa(scope, tentativaId, { estado: 'falhou' }, 'em_andamento', epoca);
    return sync.response;
  }
  if (sync._tag === 'SyncIndeterminado') {
    // A referência fica bloqueada até a reconciliação
    // (`POST /api/pedidos/manual/reconciliar`) perguntar ao Bling, por
    // `numeroLoja`, se o pedido existe.
    registrarFalhaInterna('pedidos.manual.bling.criar.ambiguo', sync.causa);
    await deps.store.registrarDesfechoDaTentativa(scope, tentativaId, { estado: 'indeterminada' }, 'em_andamento', epoca);
    return respostaCriacaoNoBlingIndeterminada();
  }
  return null;
}

/**
 * Grava a venda e devolve a resposta.
 *
 * A gravação é atômica com a POSSE (9ª rodada, B1): a mesma transação que
 * escreve pedido, itens, estoque e financeiro valida a época e conclui o
 * ledger. Por isso o caminho feliz aqui não tem uma segunda escrita — era
 * exatamente essa segunda escrita, falhando em silêncio, que produzia `201`
 * sem garantia de idempotência durável (B4).
 */
async function gravarVenda(
  contexto: {
    readonly scope: VerifiedOrganizationScope;
    readonly body: ManualOrderRequest;
    readonly cliente: ManualOrderCliente;
    readonly entrada: EntradaDoEnvio;
    readonly posse: PosseDaVenda;
    readonly blingPedidoId: string | null;
    readonly avisos: readonly string[];
  },
  deps: ManualOrderDependencies,
): Promise<NextResponse> {
  const { scope, body, cliente, entrada, posse, blingPedidoId, avisos } = contexto;

  const resultado = await deps.store.persistVenda({
    scope,
    // A POSSE ENTRA NA MESMA TRANSAÇÃO DA VENDA (9ª rodada, B1). A RPC recusa
    // a gravação inteira — pedido, itens, estoque, financeiro — se a época já
    // não for a vigente, com a linha da tentativa travada. Não é "grava e
    // depois confere": é uma coisa só.
    tentativaId: posse.tentativaId,
    epoca: posse.epoca,
    clienteId: cliente.id,
    blingPedidoId,
    referenciaLocal: entrada.referenciaLocal,
    total: entrada.total,
    desconto: body.desconto,
    frete: body.frete,
    formaPagamento: body.formaPagamentoRotulo ?? null,
    observacoes: body.observacoes ?? null,
    dataStr: entrada.dataStr,
    itens: entrada.itens,
  });

  if (resultado._tag === 'PersistVendaOk') {
    return json(
      { success: true, pedidoId: resultado.pedidoId, blingPedidoId, total: entrada.total, avisos },
      201,
    );
  }

  // A tentativa mudou de dono antes do commit: NADA foi gravado, e o ledger
  // pertence a quem tomou a posse.
  if (resultado._tag === 'PersistVendaSemPosse') {
    return respostaPosseTomada();
  }

  // Definitiva ou ambígua: as duas devolvem `{ response, desfecho }` — o
  // desfecho não é sempre 'falhou'/'indeterminada' cegamente. Uma checagem
  // dentro delas pode achar que a venda JÁ foi registrada (por uma tentativa
  // concorrente, ou porque o commit chegou entre o erro e a checagem), e nesse
  // caso o desfecho vem 'concluida' de verdade — é por isso que o registro usa
  // o que elas devolvem, não uma suposição daqui.
  const { response, desfecho } = resultado._tag === 'PersistVendaFalhouDefinitivamente'
    ? await compensarNoBling(scope, blingPedidoId, resultado.causa, deps)
    : await resolverAmbiguidadeDePersistencia(scope, blingPedidoId, resultado.causa, deps);

  // NENHUMA ESCRITA DAQUI PODE REBAIXAR UMA TENTATIVA JÁ CONCLUÍDA.
  //
  // Desde que a venda e o ledger commitam JUNTOS, uma `PersistVendaAmbigua`
  // pode significar que a transação inteira **commitou** e só a resposta se
  // perdeu — ou seja, a tentativa já está `concluida`. Gravar `indeterminada`
  // por cima disso travaria uma venda que existe: a reconciliação não teria o
  // `bling_id` para consultar (uma venda sem sincronização não tem nenhum), e
  // a referência ficaria bloqueada sem saída.
  //
  // O CAS só entra para os desfechos que rebaixam. `concluida` é gravada sem
  // CAS de propósito: escrever `concluida` sobre `concluida` é idempotente, e
  // é o desfecho de quem confirmou a venda.
  const registro = await deps.store.registrarDesfechoDaTentativa(
    scope,
    posse.tentativaId,
    desfecho,
    desfecho.estado === 'concluida' ? undefined : 'em_andamento',
    posse.epoca,
  );

  // NENHUMA RESPOSTA DE SUCESSO SEM ESTADO DURÁVEL (9ª rodada, B4). O único
  // desfecho deste bloco que responde `2xx` é `concluida` — a checagem achou a
  // venda já registrada. Se o ledger não gravou, essa resposta afirmaria uma
  // garantia de idempotência que não existe.
  if (registro._tag === 'DesfechoNaoGravado' && desfecho.estado === 'concluida') {
    return respostaLedgerNaoGravado(blingPedidoId);
  }
  return response;
}

export function createManualOrderHandler(deps: ManualOrderDependencies) {
  return async function handleManualOrder(request: Request): Promise<NextResponse> {
    const preparado = await prepararPedido(request, deps);
    if (preparado._tag === 'Rejeitado') return preparado.response;
    const { scope, body, cliente, itens, total } = preparado;

    const dataStr = toBlingDate(deps.now());
    const referenciaLocal = deps.newLocalReference(body.referenciaLocal);
    const avisos: string[] = [];

    // O fingerprint é calculado AQUI, do corpo já validado — nunca recebido do
    // cliente (5ª rodada de revisão). Um fingerprint enviado pelo cliente
    // seria só a afirmação do cliente sobre si mesmo, e a regra que ele
    // sustenta ("mesma chave + mesmo conteúdo") deixaria de valer contra um
    // cliente desatualizado, um proxy, ou uma chamada direta à API.
    const fingerprint = await fingerprintDaVendaManual(body);
    // Os VALORES resolvidos (preços do cadastro + total derivado) entram
    // separados (6ª rodada): eles não vêm do cliente, e uma mudança de preço
    // entre tentativas não pode reabrir uma tentativa em silêncio.
    const valoresFingerprint = await fingerprintDosValoresResolvidos(
      itens.map((item) => ({ produtoId: item.produto.id, precoUnitario: item.produto.preco })),
      total,
    );

    // Ticket 30, fatia 3, 3ª rodada — reivindica a referência ANTES de
    // qualquer chamada ao Bling. Uma retentativa (humana, de proxy, de
    // navegador) que reenvie a MESMA `referenciaLocal` cai num dos três
    // ramos de `respostaSeTentativaJaExistir` em vez de criar um segundo
    // pedido remoto — é isso que torna "não tente de novo" uma garantia do
    // sistema, não só uma instrução de texto.
    const decisao = decidirSobreTentativa(
      await deps.store.reivindicarTentativa(scope, referenciaLocal, fingerprint, valoresFingerprint),
    );
    if ('response' in decisao) return decisao.response;
    const { tentativaId, epoca } = decisao;

    let blingPedidoId: string | null = null;

    const posse: PosseDaVenda = { tentativaId, epoca };
    const entrada: EntradaDoEnvio = { itens, total, dataStr, referenciaLocal };

    if (body.syncBling) {
      const sync = await sincronizarComBling(scope, cliente, body, entrada, posse, deps);
      const recusa = await recusaDaSincronizacao(sync, scope, posse, deps);
      if (recusa) return recusa;
      // O `_tag` restante é `Synced` — estreitado pelo retorno acima.
      if (sync._tag === 'Synced') {
        blingPedidoId = sync.blingPedidoId;
        avisos.push(...sync.avisos);
      }
    }

    return gravarVenda(
      { scope, body, cliente, entrada, posse, blingPedidoId, avisos },
      deps,
    );
  };
}
