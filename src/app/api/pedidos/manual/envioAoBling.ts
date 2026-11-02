/**
 * O que se faz ANTES de o pedido existir no Bling: converter a data, resolver
 * o contato e montar um payload que o schema oficial aceita.
 *
 * A fase é quase toda sem efeito externo — mas NÃO inteiramente: quando o
 * cliente ainda não tem `bling_id`, `resolveBlingContato` cadastra um contato
 * na conta do lojista. É por isso que a posse é conferida ali dentro.
 *
 * O payload leva `numeroLoja = referenciaLocal`: é essa referência, decidida
 * antes do envio, que permite à reconciliação procurar o pedido se a resposta
 * da criação se perder.
 */
import type { NextResponse } from 'next/server';

import { type ManualOrderRequest } from '@/lib/config/manualOrderContract';
import { pedidoVendaPayloadSchema, type PedidoVendaPayload } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type {
  ManualOrderCliente,
  ManualOrderDependencies,
  ResolvedManualOrderItem,
} from './ports';
import { posseAindaVigente, type PosseDaVenda } from './posseDaVenda';
import { falhaDaVendaManual as fail } from './resposta';

/** Os campos da venda que o payload do Bling consome. */
export interface EntradaDoEnvio {
  readonly itens: readonly ResolvedManualOrderItem[];
  readonly total: number;
  readonly dataStr: string;
  readonly referenciaLocal: string;
}

export type BlingPayloadResult =
  | { readonly _tag: 'PayloadBuilt'; readonly payload: PedidoVendaPayload }
  | { readonly _tag: 'PayloadRejected'; readonly response: NextResponse }
  /** A posse mudou durante a preparação: nenhum efeito foi iniciado. */
  | { readonly _tag: 'PayloadSemPosse' };

/** `format: date` do Bling — AAAA-MM-DD, sem componente de hora. */
export function toBlingDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseNumericBlingId(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * O envio teria de cadastrar o contato no Bling, e o cadastro local não tem o
 * tipo de pessoa e o tipo de contribuinte escolhidos (PRE-010).
 *
 * Só um contato NOVO precisa deles: o cliente já vinculado segue com o
 * contato que o Bling tem.
 */
export function faltamDadosFiscaisParaCadastrarContato(cliente: ManualOrderCliente): boolean {
  return parseNumericBlingId(cliente.blingId) === null && cliente.dadosFiscais === null;
}

/** A recusa pede a escolha a quem opera: o ORBITA não deduz ICMS do CPF/CNPJ. */
export function mensagemDeDadosFiscaisPendentes(nome: string): string {
  return `${nome} ainda não tem cadastro no Bling, e falta escolher o tipo de pessoa e o tipo de contribuinte `
    + 'no cadastro do cliente. O CPF/CNPJ não diz se ele é contribuinte de ICMS. Complete o cadastro e envie de novo.';
}

type ContatoResult =
  | { readonly _tag: 'ContatoResolved'; readonly blingContatoId: number }
  | { readonly _tag: 'ContatoRejected'; readonly response: NextResponse }
  /** A posse mudou antes de cadastrar o contato: nada foi criado no ERP. */
  | { readonly _tag: 'ContatoSemPosse' };

/** Garante um id numérico de contato no Bling, cadastrando o cliente se necessário. */
async function resolveBlingContato(
  scope: VerifiedOrganizationScope,
  cliente: ManualOrderCliente,
  posse: PosseDaVenda,
  deps: ManualOrderDependencies,
): Promise<ContatoResult> {
  const existente = parseNumericBlingId(cliente.blingId);
  if (existente !== null) {
    return { _tag: 'ContatoResolved', blingContatoId: existente };
  }

  // `prepararPedido` já recusou este caso antes do claim; a conferência aqui
  // garante que nenhum caminho chegue ao POST sem a escolha do cadastro.
  const { dadosFiscais } = cliente;
  if (dadosFiscais === null) {
    return { _tag: 'ContatoRejected', response: fail(mensagemDeDadosFiscaisPendentes(cliente.nome), 400) };
  }

  // CADASTRAR O CONTATO É EFEITO NO ERP: esta função CRIA um contato na conta
  // do lojista e grava o vínculo local. Um executor que já perdeu a posse não
  // deve chegar a esse efeito.
  //
  // A conferência fica DENTRO do ramo que muta, e não antes da preparação
  // inteira: um cliente já vinculado não paga round-trip nenhum a mais.
  if (!await posseAindaVigente(scope, posse, 'contato', deps)) {
    return { _tag: 'ContatoSemPosse' };
  }

  const criado = await deps.bling.createContato({
    nome: cliente.nome,
    email: cliente.email,
    telefone: cliente.telefone,
    documento: cliente.cpfCnpj,
    tipo: dadosFiscais.tipo,
    indicadorIe: dadosFiscais.indicadorIe,
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
 * Tudo o que precisa dar certo ANTES de o pedido poder existir no Bling:
 * contato, forma de pagamento e um payload que o schema oficial aceita.
 *
 * Uma recusa desta fase é `SyncRejected` — nada de PEDIDO existe no ERP. O
 * único efeito externo possível aqui é o cadastro do contato, e ele acontece
 * atrás da conferência de posse. Cadastrar um contato não cria venda, então
 * não há pedido ambíguo a reconciliar; no pior caso fica um contato cadastrado
 * no Bling sem pedido associado.
 */
export async function prepararEnvioAoBling(
  scope: VerifiedOrganizationScope,
  cliente: ManualOrderCliente,
  body: ManualOrderRequest,
  entrada: EntradaDoEnvio,
  posse: PosseDaVenda,
  deps: ManualOrderDependencies,
): Promise<BlingPayloadResult> {
  const contatoResult = await resolveBlingContato(scope, cliente, posse, deps);
  if (contatoResult._tag === 'ContatoSemPosse') {
    return { _tag: 'PayloadSemPosse' };
  }
  if (contatoResult._tag === 'ContatoRejected') {
    return { _tag: 'PayloadRejected', response: contatoResult.response };
  }

  let formaPagamentoId = body.formaPagamentoId;
  if (formaPagamentoId === undefined) {
    const padrao = await deps.bling.getDefaultFormaPagamentoId();
    if (padrao._tag === 'BlingFailed') {
      return {
        _tag: 'PayloadRejected',
        response: fail(
          `Não foi possível descobrir a forma de pagamento padrão no Bling: ${padrao.failure.message}. Configure uma forma de pagamento padrão na conta.`,
          400,
        ),
      };
    }
    formaPagamentoId = padrao.value;
  }

  return buildPedidoVendaPayload({
    blingContatoId: contatoResult.blingContatoId,
    itens: entrada.itens,
    total: entrada.total,
    desconto: body.desconto,
    frete: body.frete,
    observacoes: body.observacoes ?? null,
    formaPagamentoId,
    dataStr: entrada.dataStr,
    referenciaLocal: entrada.referenciaLocal,
  });
}
