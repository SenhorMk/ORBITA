import { NextResponse } from 'next/server';

import {
  calculateManualOrderTotal,
  manualOrderRequestSchema,
  type ManualOrderRequest,
} from '@/lib/config/manualOrderContract';
import { pedidoVendaPayloadSchema, type PedidoVendaPayload } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { descreverErro } from '@/lib/erroLegivel';

import type {
  ManualOrderCliente,
  ManualOrderDependencies,
  ManualOrderResponseBody,
  ManualOrderStorePort,
  ResolvedManualOrderItem,
} from './ports';

export * from './ports';

function json(body: ManualOrderResponseBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

function fail(error: string, status: number, extra: Partial<ManualOrderResponseBody> = {}): NextResponse {
  return json({ success: false, error, ...extra }, status);
}

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

type ResolveItensResult =
  | { readonly _tag: 'ItensResolved'; readonly itens: readonly ResolvedManualOrderItem[] }
  | { readonly _tag: 'ItensRejected'; readonly response: NextResponse };

/**
 * Casa os itens pedidos com o cadastro local dentro do escopo da organização.
 * O preço usado é sempre o do cadastro: o corpo da requisição não carrega
 * preço nem total justamente para que o cliente não possa ditar o valor.
 */
async function resolveItens(
  scope: VerifiedOrganizationScope,
  body: ManualOrderRequest,
  store: ManualOrderStorePort,
): Promise<ResolveItensResult> {
  const produtoIds = body.itens.map((item) => item.produtoId);
  const duplicados = produtoIds.length !== new Set(produtoIds).size;
  if (duplicados) {
    return { _tag: 'ItensRejected', response: fail('O pedido tem o mesmo produto repetido em itens diferentes. Ajuste a quantidade em vez de repetir o item.', 400) };
  }

  const produtos = await store.findProdutosByIds(scope, produtoIds);
  const porId = new Map(produtos.map((produto) => [produto.id, produto]));

  const itens: ResolvedManualOrderItem[] = [];
  for (const item of body.itens) {
    const produto = porId.get(item.produtoId);
    if (!produto) {
      return { _tag: 'ItensRejected', response: fail(`Produto não encontrado no cadastro desta organização (${item.produtoId}).`, 400) };
    }
    if (produto.estoqueDisponivel < item.quantidade) {
      return {
        _tag: 'ItensRejected',
        response: fail(`Estoque insuficiente para ${produto.nome}. Disponível: ${produto.estoqueDisponivel}, pedido: ${item.quantidade}.`, 400),
      };
    }
    itens.push({ produto, quantidade: item.quantidade });
  }

  return { _tag: 'ItensResolved', itens };
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

type SyncResult =
  | { readonly _tag: 'Synced'; readonly blingPedidoId: string; readonly avisos: readonly string[] }
  | { readonly _tag: 'SyncRejected'; readonly response: NextResponse };

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

  const criado = await deps.bling.createPedidoVenda(payloadResult.payload);
  if (criado._tag === 'BlingFailed') {
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
 */
async function compensarNoBling(
  blingPedidoId: string | null,
  error: unknown,
  deps: ManualOrderDependencies,
): Promise<NextResponse> {
  const causa = descreverErro(error);

  if (blingPedidoId === null) {
    return fail(`Falha ao registrar a venda no ORBITA: ${causa}.`, 500, { blingPedidoId });
  }

  const compensacao = await deps.bling.cancelarPedidoVenda(blingPedidoId);
  if (compensacao._tag === 'BlingFailed') {
    // As duas metades falharam. É o único caminho que exige ação humana, e por
    // isso ele diz exatamente o quê, onde e por quê.
    return fail(
      `Falha ao registrar a venda no ORBITA: ${causa}. O pedido ${blingPedidoId} foi criado no Bling e o `
        + `cancelamento automático também falhou (${compensacao.failure.message}). `
        + 'Cancele o pedido no Bling antes de tentar de novo, senão a próxima tentativa cria outro.',
      500,
      { blingPedidoId, compensado: false },
    );
  }

  return fail(
    `Falha ao registrar a venda no ORBITA: ${causa}. O pedido ${blingPedidoId} foi cancelado no Bling `
      + 'automaticamente, então nada ficou pendente lá. Pode tentar de novo.',
    500,
    { blingPedidoId, compensado: true },
  );
}

/**
 * `POST /api/pedidos/manual`.
 *
 * A venda só é gravada localmente depois que o Bling confirma a criação do
 * pedido, quando o envio ao ERP foi pedido. Falha parcial (a baixa de estoque
 * no Bling, que acontece depois do pedido já existir) vira aviso explícito na
 * resposta, nunca um `catch` silencioso nem um sucesso mascarado.
 */
export function createManualOrderHandler(deps: ManualOrderDependencies) {
  return async function handleManualOrder(request: Request): Promise<NextResponse> {
    const session = await deps.auth.authenticate(request);
    if (!session) {
      return fail('Não autorizado', 401);
    }

    const scopeResult = await deps.auth.resolveScope(request);
    if (scopeResult._tag === 'Denied') {
      return scopeResult.response;
    }
    const { scope } = scopeResult;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return fail('Corpo da requisição não é um JSON válido.', 400);
    }

    const parsedBody = manualOrderRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      const detalhes = parsedBody.error.issues.map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`).join('; ');
      return fail(`Pedido inválido: ${detalhes}`, 400);
    }
    const body = parsedBody.data;

    const cliente = await deps.store.findClienteById(scope, body.clienteId);
    if (!cliente) {
      return fail('Cliente não encontrado no cadastro desta organização.', 400);
    }

    const itensResult = await resolveItens(scope, body, deps.store);
    if (itensResult._tag === 'ItensRejected') {
      return itensResult.response;
    }
    const { itens } = itensResult;

    const total = calculateManualOrderTotal(
      itens.map((item) => ({ quantidade: item.quantidade, valorUnitario: item.produto.preco })),
      body.desconto,
      body.frete,
    );

    const dataStr = toBlingDate(deps.now());
    const referenciaLocal = deps.newLocalReference();
    const avisos: string[] = [];
    let blingPedidoId: string | null = null;

    if (body.syncBling) {
      const sync = await sincronizarComBling(scope, cliente, body, itens, total, dataStr, referenciaLocal, deps);
      if (sync._tag === 'SyncRejected') {
        return sync.response;
      }
      blingPedidoId = sync.blingPedidoId;
      avisos.push(...sync.avisos);
    }

    try {
      const { pedidoId } = await deps.store.persistVenda({
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

      return json({ success: true, pedidoId, blingPedidoId, total, avisos }, 201);
    } catch (error: unknown) {
      return compensarNoBling(blingPedidoId, error, deps);
    }
  };
}
