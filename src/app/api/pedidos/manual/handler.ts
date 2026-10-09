/**
 * `POST /api/pedidos/manual` — registra uma venda manual e, opcionalmente, cria
 * o pedido no Bling.
 *
 * O problema central: o ORBITA pode mandar criar um pedido no Bling e perder a
 * resposta. Nesse caso ele não pode assumir nem que criou nem que não criou —
 * tentar de novo às cegas pode gerar um segundo pedido real. Por isso cada
 * tentativa fica registrada no banco e, se o resultado ficar desconhecido,
 * bloqueada até ser esclarecido. Banco local e Bling não formam uma única
 * transação; este fluxo existe para lidar com isso.
 *
 * VEIO DE: `route.ts` (fronteira HTTP), com o escopo já verificado.
 *
 * Passo a passo (e onde cada um acontece):
 * 1. REGRA — `prepararPedido` (`preparacao.ts`) confere o escopo, valida o
 *    corpo e busca cliente e produtos no cadastro — **preço e total são
 *    calculados no servidor**;
 * 2. REGRA — fingerprint (`manualOrderFingerprint.ts`): um resumo (hash) do
 *    conteúdo da venda. A mesma referência usada para outra venda vira conflito;
 * 3. EFEITO LOCAL — claim: antes de chamar o Bling, a tentativa é reservada no
 *    ledger (o registro persistente das tentativas) pela referência da venda
 *    (RPC `reivindicar_tentativa_venda_manual`, via `dependencias.ts`). O claim
 *    devolve uma época — o "número de posse" da tentativa. Os desfechos que
 *    param aqui estão em `decisaoDeTentativa.ts`;
 * 4. EFEITO EXTERNO — criação no Bling (`envioAoBling.ts` monta o payload;
 *    `BlingClient.criarPedidoVenda` chama a API), com a posse conferida logo
 *    antes (`posseDaVenda.ts`);
 * 5. EFEITO LOCAL — pedido, itens, estoque, título financeiro e conclusão da
 *    tentativa são gravados numa única transação do Postgres (RPC
 *    `registrar_venda_manual_com_posse`), recusada se a época mudou;
 * 6. EFEITO EXTERNO — só então o lançamento de estoque no Bling.
 *
 * RESULTADO: conhecido → resposta final. Se a gravação local falha depois de o
 * Bling aceitar, há dois caminhos em `compensacao.ts`:
 * - falha local definitiva → `compensarNoBling` (cancela no Bling);
 * - resultado local ambíguo → `resolverAmbiguidadeDePersistencia` (nunca
 *   compensa; sem confirmação, a tentativa fica `indeterminada`).
 * Nos dois, se a checagem provar que a venda já foi gravada, não há compensação.
 * Resposta do Bling que não chegou é resultado **ambíguo**,
 * não falha: a tentativa fica `indeterminada` e só sai pela reconciliação
 * (`reconciliar/route.ts` → `reconciliacao.ts`).
 */
import { NextResponse } from 'next/server';

import { type ManualOrderRequest } from '@/lib/config/manualOrderContract';
import { fingerprintDaVendaManual, fingerprintDosValoresResolvidos } from '@/lib/config/manualOrderFingerprint';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import {
  compensarNoBling,
  resolverAmbiguidadeDePersistencia,
  respostaCriacaoNoBlingIndeterminada,
  respostaVendaJaRegistrada,
} from './compensacao';
import { classificarFalhaDeCriacaoNoBling } from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
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
 * Desfecho da sincronização com o Bling. `SyncRejected` e `SyncIndeterminado`
 * exigem reações OPOSTAS no ledger de idempotência.
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
   * A posse da tentativa mudou. Nenhum efeito externo NOVO é iniciado a partir
   * daqui, e o ledger não é tocado: quem tomou a posse é quem decide o desfecho.
   */
  | { readonly _tag: 'SyncSemPosse' };

/**
 * Cria o pedido no Bling. **Não lança o estoque** — ver `lancarEstoqueDaVenda`.
 *
 * A ordem é `criar no Bling → gravar venda + tentativa no banco local →
 * lançar estoque no Bling`. Por quê: conferir a posse antes de um efeito não
 * impede que o efeito chegue tarde. Se o estoque fosse lançado antes da
 * gravação local, essa chamada poderia chegar ao Bling DEPOIS de a
 * reconciliação ter assumido a tentativa e cancelado o pedido.
 *
 * Com a gravação local no meio, quem decide é o banco (erro `55P03` quando a
 * época mudou):
 * - se a reconciliação assumiu a tentativa antes da gravação,
 *   `registrar_venda_manual_com_posse` recusa, e este executor não lança estoque;
 * - se a gravação aconteceu primeiro, a tentativa já está `concluida` e não
 *   pode mais ser assumida nem cancelada (`tentativaPodeSerReconciliada`).
 *
 * Assim o estoque no Bling só é lançado por quem de fato concluiu a venda.
 */
async function sincronizarComBling(
  scope: VerifiedOrganizationScope,
  cliente: ManualOrderCliente,
  body: ManualOrderRequest,
  entrada: EntradaDoEnvio,
  posse: PosseDaVenda,
  deps: ManualOrderDependencies,
): Promise<SyncResult> {
  const payloadResult = await prepararEnvioAoBling(scope, cliente, body, entrada, posse, deps);
  if (payloadResult._tag === 'PayloadSemPosse') {
    return { _tag: 'SyncSemPosse' };
  }
  if (payloadResult._tag === 'PayloadRejected') {
    return { _tag: 'SyncRejected', response: payloadResult.response };
  }

  // A PARTIR DAQUI o pedido pode existir no Bling. Uma exceção lançada aqui —
  // timeout, conexão perdida, abort — não prova que nada foi criado: prova só
  // que a RESPOSTA não chegou. Deixá-la subir marcaria a tentativa como
  // `falhou` (reabrível) ou a deixaria presa em `em_andamento`; as duas coisas
  // estariam erradas.
  //
  // FENCING DO EFEITO COMERCIAL: um executor que já perdeu a posse não pode
  // criar o pedido no ERP. A pergunta é feita aqui, o mais tarde possível
  // antes do envio — o que reduz a janela, mas não a elimina.
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

  return {
    _tag: 'Synced',
    blingPedidoId: criado.value.id,
    avisos: criado.value.alertas.map((alerta) => `Bling: ${alerta}`),
  };
}

/**
 * Lança no ERP o estoque do pedido — DEPOIS de a venda e o ledger estarem
 * commitados.
 *
 * A falha vira aviso: ela acontece com o pedido já existindo no ERP e com a
 * venda já gravada aqui, então não pode derrubar a resposta nem ser engolida.
 * Só o executor que concluiu a tentativa chega aqui; uma retentativa com a
 * mesma referência encontra a tentativa `concluida` e não relança.
 */
async function lancarEstoqueDaVenda(
  blingPedidoId: string | null,
  deps: ManualOrderDependencies,
): Promise<readonly string[]> {
  if (blingPedidoId === null) return [];

  // A exceção também vira aviso. Como a baixa acontece DEPOIS do commit,
  // deixá-la subir trocaria um `201` legítimo por um `500` sobre uma venda que
  // existe nos dois lados — e a retentativa encontraria a tentativa
  // `concluida` e nunca relançaria o estoque.
  let estoque: Awaited<ReturnType<ManualOrderDependencies['bling']['lancarEstoquePedido']>>;
  try {
    estoque = await deps.bling.lancarEstoquePedido(blingPedidoId);
  } catch (causa) {
    registrarFalhaInterna('pedidos.manual.bling.estoque', causa);
    return [
      `O pedido ${blingPedidoId} foi criado no Bling e a venda foi registrada, mas a baixa de estoque `
      + 'no ERP não teve resposta. Confira o estoque no Bling.',
    ];
  }
  if (estoque._tag === 'BlingOk') return [];

  return [
    `O pedido ${blingPedidoId} foi criado no Bling, mas a baixa de estoque no ERP falhou: `
    + `${estoque.failure.message}. Confira o estoque no Bling.`,
  ];
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
  // o defeito que o fencing existe para impedir.
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
 * Grava a venda no banco local e devolve a resposta.
 *
 * EFEITO LOCAL: a garantia de tudo-ou-nada começa no Postgres, não no Bling.
 * Este código chama `store.persistVenda` (`dependencias.ts`), que só executa a
 * RPC `registrar_venda_manual_com_posse` (migration 59 → migration 61).
 * Numa única transação do Postgres, a RPC confere a época (a posse), grava
 * pedido, itens, baixa de estoque e título financeiro, e marca a tentativa como
 * `concluida`. Se algo falhar lá dentro, a transação local volta inteira. Isso
 * **não** inclui o Bling: o pedido no ERP, se foi criado, continua lá, e é por
 * isso que existem a compensação e a reconciliação abaixo.
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
    // A POSSE ENTRA NA MESMA TRANSAÇÃO LOCAL DA VENDA. A RPC trava a linha da
    // tentativa e recusa a gravação inteira — pedido, itens, estoque,
    // financeiro — se a época já não for a vigente. Não é "grava e depois
    // confere": é uma coisa só.
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

  // O COMMIT VENCEU: a venda e o ledger existem, e a tentativa está
  // `concluida`. Só agora o estoque remoto é lançado — antes disso, ninguém
  // sabia quem tinha vencido a corrida com a reconciliação.
  if (resultado._tag === 'PersistVendaOk') {
    const avisosDoEstoque = await lancarEstoqueDaVenda(blingPedidoId, deps);
    return json(
      {
        success: true,
        pedidoId: resultado.pedidoId,
        blingPedidoId,
        total: entrada.total,
        avisos: [...avisos, ...avisosDoEstoque],
      },
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
  // Como a venda e o ledger commitam JUNTOS, uma `PersistVendaAmbigua`
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

  // NENHUMA RESPOSTA DE SUCESSO SEM ESTADO DURÁVEL. O único
  // desfecho deste bloco que responde `2xx` é `concluida` — a checagem achou a
  // venda já registrada. Se o ledger não gravou, essa resposta afirmaria uma
  // garantia de idempotência que não existe.
  if (registro._tag === 'DesfechoNaoGravado' && desfecho.estado === 'concluida') {
    return respostaLedgerNaoGravado(blingPedidoId);
  }

  // A CONFIRMAÇÃO PROVOU QUE O COMMIT ACONTECEU. A resposta
  // se perdeu, mas a venda e o ledger existem — este executor é o vencedor, e
  // o lançamento de estoque que ficou pendente é dele. Uma vez só: a próxima
  // requisição com a mesma referência encontra a tentativa `concluida` e nem
  // chega aqui.
  if (desfecho.estado === 'concluida' && desfecho.pedidoId !== undefined) {
    const avisosDoEstoque = await lancarEstoqueDaVenda(blingPedidoId, deps);
    return respostaVendaJaRegistrada(desfecho.pedidoId, blingPedidoId, avisosDoEstoque);
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
    // cliente. Um fingerprint enviado pelo cliente seria só a afirmação do
    // cliente sobre si mesmo, e a regra que ele sustenta ("mesma chave + mesmo
    // conteúdo") deixaria de valer contra um cliente desatualizado, um proxy,
    // ou uma chamada direta à API.
    const fingerprint = await fingerprintDaVendaManual(body);
    // Os VALORES resolvidos (preços do cadastro + total derivado) entram
    // separados: eles não vêm do cliente, e uma mudança de preço entre
    // tentativas não pode reabrir uma tentativa em silêncio.
    const valoresFingerprint = await fingerprintDosValoresResolvidos(
      itens.map((item) => ({ produtoId: item.produto.id, precoUnitario: item.produto.preco })),
      total,
    );

    // CLAIM: reivindica a referência ANTES de qualquer chamada ao Bling. Uma
    // retentativa (humana, de proxy, de navegador) que reenvie a MESMA
    // `referenciaLocal` recebe de `decidirSobreTentativa` uma resposta pronta
    // em vez de repetir a criação remota — a proteção contra duplicação fica
    // no servidor, e não depende de o usuário seguir a instrução da tela.
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
