import { NextResponse } from 'next/server';

import { type ManualOrderRequest } from '@/lib/config/manualOrderContract';
import { fingerprintDaVendaManual, fingerprintDosValoresResolvidos } from '@/lib/config/manualOrderFingerprint';
import { pedidoVendaPayloadSchema, type PedidoVendaPayload } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import {
  compensarNoBling,
  resolverAmbiguidadeDePersistencia,
  respostaCriacaoNoBlingIndeterminada,
} from './compensacao';
import { classificarFalhaDeCriacaoNoBling } from './classificacaoDeFalhaBling';
import { decidirSobreTentativa } from './decisaoDeTentativa';
import { prepararPedido } from './preparacao';
import { falhaDaVendaManual as fail, jsonDaVendaManual as json } from './resposta';
import type {
  ManualOrderCliente,
  ManualOrderDependencies,
  ResolvedManualOrderItem,
} from './ports';

export * from './ports';
export { compensarNoBling, resolverAmbiguidadeDePersistencia } from './compensacao';

/** `format: date` do Bling — AAAA-MM-DD, sem componente de hora. */
function toBlingDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseNumericBlingId(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}


type ContatoResult =
  | { readonly _tag: 'ContatoResolved'; readonly blingContatoId: number }
  | { readonly _tag: 'ContatoRejected'; readonly response: NextResponse };

/** Garante um id numérico de contato no Bling, cadastrando o cliente se necessário. */
async function resolveBlingContato(
  scope: VerifiedOrganizationScope,
  cliente: ManualOrderCliente,
  deps: ManualOrderDependencies,
): Promise<ContatoResult> {
  const existente = parseNumericBlingId(cliente.blingId);
  if (existente !== null) {
    return { _tag: 'ContatoResolved', blingContatoId: existente };
  }

  const criado = await deps.bling.createContato({
    nome: cliente.nome,
    email: cliente.email,
    telefone: cliente.telefone,
    documento: cliente.cpfCnpj,
  });

  if (criado._tag === 'BlingFailed') {
    return {
      _tag: 'ContatoRejected',
      response: fail(`Não foi possível cadastrar o cliente no Bling: ${criado.failure.message}`, 400),
    };
  }

  await deps.store.linkClienteBlingId(scope, cliente.id, String(criado.value.id));
  return { _tag: 'ContatoResolved', blingContatoId: criado.value.id };
}

type BlingPayloadResult =
  | { readonly _tag: 'PayloadBuilt'; readonly payload: PedidoVendaPayload }
  | { readonly _tag: 'PayloadRejected'; readonly response: NextResponse };

/**
 * Monta e valida o corpo de `POST /pedidos/vendas` contra o schema oficial.
 * Validar antes de enviar troca um `400` opaco do provedor por uma mensagem
 * que diz exatamente o que falta.
 */
function buildPedidoVendaPayload(
  input: {
    readonly blingContatoId: number;
    readonly itens: readonly ResolvedManualOrderItem[];
    readonly total: number;
    readonly desconto: number;
    readonly frete: number;
    readonly observacoes: string | null;
    readonly formaPagamentoId: number;
    readonly dataStr: string;
    readonly referenciaLocal: string;
  },
): BlingPayloadResult {
  const itensSemBlingId = input.itens.filter((item) => parseNumericBlingId(item.produto.blingId) === null);
  if (itensSemBlingId.length > 0) {
    const nomes = itensSemBlingId.map((item) => item.produto.nome).join(', ');
    return {
      _tag: 'PayloadRejected',
      response: fail(
        `Estes produtos ainda não estão sincronizados com o Bling e por isso não podem entrar em um pedido enviado ao ERP: ${nomes}. Sincronize o catálogo ou desmarque o envio ao Bling.`,
        400,
      ),
    };
  }

  const candidato = {
    contato: { id: input.blingContatoId },
    data: input.dataStr,
    dataPrevista: input.dataStr,
    dataSaida: input.dataStr,
    numeroLoja: input.referenciaLocal,
    itens: input.itens.map((item) => ({
      descricao: item.produto.nome,
      quantidade: item.quantidade,
      valor: item.produto.preco,
      // Sem desconto por item: o desconto da venda é aplicado no cabeçalho,
      // então o preço de lista é o próprio preço praticado.
      valorLista: item.produto.preco,
      ...(item.produto.codigo ? { codigo: item.produto.codigo } : {}),
      produto: { id: parseNumericBlingId(item.produto.blingId)! },
    })),
    parcelas: [
      {
        dataVencimento: input.dataStr,
        valor: input.total,
        formaPagamento: { id: input.formaPagamentoId },
      },
    ],
    ...(input.observacoes ? { observacoes: input.observacoes } : {}),
    ...(input.desconto > 0 ? { desconto: { valor: input.desconto, unidade: 'REAL' as const } } : {}),
    ...(input.frete > 0 ? { transporte: { frete: input.frete } } : {}),
  };

  const parsed = pedidoVendaPayloadSchema.safeParse(candidato);
  if (!parsed.success) {
    const detalhes = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { _tag: 'PayloadRejected', response: fail(`Pedido incompleto para o Bling: ${detalhes}`, 400) };
  }

  return { _tag: 'PayloadBuilt', payload: parsed.data };
}

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
  | { readonly _tag: 'SyncIndeterminado'; readonly causa: unknown };

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
  itens: readonly ResolvedManualOrderItem[],
  total: number,
  dataStr: string,
  referenciaLocal: string,
  deps: ManualOrderDependencies,
): Promise<SyncResult> {
  const contatoResult = await resolveBlingContato(scope, cliente, deps);
  if (contatoResult._tag === 'ContatoRejected') {
    return { _tag: 'SyncRejected', response: contatoResult.response };
  }

  let formaPagamentoId = body.formaPagamentoId;
  if (formaPagamentoId === undefined) {
    const padrao = await deps.bling.getDefaultFormaPagamentoId();
    if (padrao._tag === 'BlingFailed') {
      return {
        _tag: 'SyncRejected',
        response: fail(
          `Não foi possível descobrir a forma de pagamento padrão no Bling: ${padrao.failure.message}. Configure uma forma de pagamento padrão na conta.`,
          400,
        ),
      };
    }
    formaPagamentoId = padrao.value;
  }

  const payloadResult = buildPedidoVendaPayload({
    blingContatoId: contatoResult.blingContatoId,
    itens,
    total,
    desconto: body.desconto,
    frete: body.frete,
    observacoes: body.observacoes ?? null,
    formaPagamentoId,
    dataStr,
    referenciaLocal,
  });
  if (payloadResult._tag === 'PayloadRejected') {
    return { _tag: 'SyncRejected', response: payloadResult.response };
  }

  // A PARTIR DAQUI o pedido pode existir no Bling (5ª rodada de revisão).
  // Uma exceção lançada aqui — timeout, conexão perdida, abort — não prova
  // que nada foi criado: prova só que a RESPOSTA não chegou. Deixá-la subir
  // marcaria a tentativa como `falhou` (reabrível) ou a deixaria presa em
  // `em_andamento` para sempre; as duas coisas estão erradas.
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
  tentativaId: string,
  deps: ManualOrderDependencies,
): Promise<NextResponse | null> {
  if (sync._tag === 'SyncRejected') {
    await deps.store.registrarDesfechoDaTentativa(scope, tentativaId, { estado: 'falhou' });
    return sync.response;
  }
  if (sync._tag === 'SyncIndeterminado') {
    // A referência fica bloqueada até a reconciliação
    // (`POST /api/pedidos/manual/reconciliar`) perguntar ao Bling, por
    // `numeroLoja`, se o pedido existe.
    registrarFalhaInterna('pedidos.manual.bling.criar.ambiguo', sync.causa);
    await deps.store.registrarDesfechoDaTentativa(scope, tentativaId, { estado: 'indeterminada' });
    return respostaCriacaoNoBlingIndeterminada();
  }
  return null;
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
    const { tentativaId } = decisao;

    let blingPedidoId: string | null = null;

    if (body.syncBling) {
      const sync = await sincronizarComBling(scope, cliente, body, itens, total, dataStr, referenciaLocal, deps);
      const recusa = await recusaDaSincronizacao(sync, scope, tentativaId, deps);
      if (recusa) return recusa;
      // O `_tag` restante é `Synced` — estreitado pelo retorno acima.
      if (sync._tag === 'Synced') {
        blingPedidoId = sync.blingPedidoId;
        avisos.push(...sync.avisos);
      }
    }

    const resultado = await deps.store.persistVenda({
      scope,
      clienteId: cliente.id,
      blingPedidoId,
      referenciaLocal,
      total,
      desconto: body.desconto,
      frete: body.frete,
      formaPagamento: body.formaPagamentoRotulo ?? null,
      observacoes: body.observacoes ?? null,
      dataStr,
      itens,
    });

    if (resultado._tag === 'PersistVendaOk') {
      await deps.store.registrarDesfechoDaTentativa(scope, tentativaId, {
        estado: 'concluida',
        pedidoId: resultado.pedidoId,
        blingPedidoId,
      });
      return json({ success: true, pedidoId: resultado.pedidoId, blingPedidoId, total, avisos }, 201);
    }

    // Definitiva ou ambígua: as duas devolvem `{ response, desfecho }` — o
    // desfecho não é sempre 'falhou'/'indeterminada' cegamente. Uma checagem
    // dentro delas pode achar que a venda JÁ foi registrada (por uma
    // tentativa concorrente, ou porque o commit chegou entre o erro e a
    // checagem), e nesse caso o desfecho vem 'concluida' de verdade — é por
    // isso que o registro usa o que elas devolvem, não uma suposição daqui.
    const { response, desfecho } = resultado._tag === 'PersistVendaFalhouDefinitivamente'
      ? await compensarNoBling(scope, blingPedidoId, resultado.causa, deps)
      : await resolverAmbiguidadeDePersistencia(scope, blingPedidoId, resultado.causa, deps);
    await deps.store.registrarDesfechoDaTentativa(scope, tentativaId, desfecho);
    return response;
  };
}
