import { NextResponse } from 'next/server';

import type { z } from 'zod';

import {
  produtoRequestSchema,
  type desfechoDoSaldoSchema,
  type MotivoDaReconciliacao,
  type ProdutoRequest,
} from '@/lib/config/produtoContract';
import { classificarFalhaDeCriacaoNoBling } from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import { blingFailure, type BlingCallResult, type BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { descreverErro } from '@/lib/erroLegivel';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

/** Produto como o Bling o descreve, reduzido ao que esta rota precisa. */
export interface BlingProdutoResumo {
  readonly id: string;
  readonly codigo: string | null;
}

export interface ProdutoBlingPort {
  /**
   * Busca por SKU **exato**, já conferido pelo adapter. Devolver `null` quando
   * não há correspondência é essencial: um filtro ignorado pelo provedor
   * devolvia a lista inteira, e tratar o primeiro item como "já existe"
   * disparava um PUT destrutivo sobre um produto não relacionado.
   */
  buscarPorCodigo(codigo: string): Promise<BlingCallResult<BlingProdutoResumo | null>>;
  criar(payload: ProdutoBlingPayload): Promise<BlingCallResult<{ id: string }>>;
  atualizar(id: string, payload: ProdutoBlingPayload): Promise<BlingCallResult<void>>;
  /** Saldo absoluto por `POST /estoques`; nunca pelo payload do produto. */
  definirSaldo(id: string, quantidade: number): Promise<BlingCallResult<void>>;
}

export interface ProdutoBlingPayload {
  readonly nome: string;
  readonly codigo?: string;
  readonly preco: number;
  readonly tipo: string;
  readonly situacao: string;
  readonly formato: string;
  readonly unidade: string;
  /**
   * `ProdutosCategoriaDTO` do OpenAPI oficial: um objeto cujo único campo
   * obrigatório é `id`, e `id` é **integer** — o id da categoria no Bling, não
   * o UUID local. Ausente quando ninguém escolheu categoria; omitir não é o
   * mesmo que remover a categoria no ERP, e esta rota não remove nada.
   */
  readonly categoria?: { readonly id: number };
}

/**
 * Traduz o UUID local da categoria no id do Bling, dentro da organização
 * verificada.
 *
 * O navegador só manda UUID local, e é a única coisa em que se pode confiar:
 * um id externo vindo do cliente permitiria apontar o produto para a categoria
 * de outra conta do ERP. A consulta é do servidor e filtra explicitamente por
 * `organizacao_id` — service-role não dispensa o escopo.
 */
export interface ProdutoCategoriaPort {
  /** `null` quando o UUID não existe, é de outra organização, ou não tem `bling_id` utilizável. */
  resolverBlingId(scope: VerifiedOrganizationScope, categoriaId: string): Promise<number | null>;
}

export interface ProdutoPersistido {
  readonly id: string;
  readonly blingId: string;
  readonly nome: string;
  readonly codigo: string | null;
  readonly preco: number;
  readonly estoque: number;
}

export interface ProdutoStorePort {
  upsert(scope: VerifiedOrganizationScope, produto: {
    readonly id?: string;
    readonly blingId: string;
    readonly nome: string;
    readonly codigo: string | null;
    readonly preco: number;
    /**
     * Ausente = o saldo local não muda. Só vem quando o Bling confirmou o
     * balanço: o espelho nunca recebe um saldo que o ERP não aceitou.
     */
    readonly estoque?: number;
    readonly categoriaId?: string;
  }): Promise<ProdutoPersistido>;
}

/** Cadastro novo no Bling ou atualização de um produto que já está lá. */
export type OperacaoNoBling = 'cadastro' | 'atualizacao';

/** O que aconteceu com o saldo pedido pelo formulário. */
export type DesfechoDoSaldo = z.infer<typeof desfechoDoSaldoSchema>;

/**
 * Evento de auditoria do produto. Metadata só com ids técnicos e desfecho —
 * nunca nome, SKU, preço ou corpo do Bling.
 *
 * - `catalog.product_saved`: o Bling confirmou e o ORBITA espelhou;
 * - `catalog.product_save_rejected`: o Bling recusou a requisição, sem efeito;
 * - `catalog.product_reconcile_required`: o Bling não confirmou (pode ter
 *   aplicado), ou confirmou e o espelho local falhou.
 */
export type EventoDoProduto =
  | {
      readonly acao: 'catalog.product_saved';
      readonly recursoId: string;
      readonly correlationId: string;
      readonly metadata: {
        readonly produto_id: string;
        readonly bling_id: string;
        readonly operacao: OperacaoNoBling;
        readonly saldo: DesfechoDoSaldo;
      };
    }
  | {
      readonly acao: 'catalog.product_save_rejected';
      readonly recursoId: string | null;
      readonly correlationId: string;
      readonly metadata: {
        readonly operacao: OperacaoNoBling;
        readonly tipo_erro: string;
        readonly status_http: number;
      };
    }
  | {
      readonly acao: 'catalog.product_reconcile_required';
      readonly recursoId: string | null;
      readonly correlationId: string;
      readonly metadata: {
        readonly operacao: OperacaoNoBling;
        readonly motivo: MotivoDaReconciliacao;
        readonly bling_id: string | null;
      };
    };

export interface ProdutoAuthPort {
  authorize(request: Request): Promise<
    | { readonly _tag: 'Authorized'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Denied'; readonly response: NextResponse }
  >;
}

export interface ProdutoDependencies {
  readonly auth: ProdutoAuthPort;
  readonly bling: ProdutoBlingPort;
  readonly store: ProdutoStorePort;
  readonly categorias: ProdutoCategoriaPort;
  /** Trilha persistente (`recordAuditEvent`). Falhar aqui nunca muda a resposta. */
  readonly auditar: (scope: VerifiedOrganizationScope, evento: EventoDoProduto) => Promise<void>;
  readonly correlationId: (request: Request) => string;
}

export interface ProdutoResponseBody {
  readonly success: boolean;
  readonly product?: ProdutoPersistido;
  readonly avisos?: readonly string[];
  readonly saldo?: DesfechoDoSaldo;
  readonly error?: string;
  /** Presente quando o resultado é indeterminado: a tela não oferece nova tentativa. */
  readonly reconciliacao?: { readonly motivo: MotivoDaReconciliacao; readonly blingId: string | null };
}

function fail(error: string, status: number, reconciliacao?: ProdutoResponseBody['reconciliacao']): NextResponse {
  return NextResponse.json(
    { success: false, error, ...(reconciliacao ? { reconciliacao } : {}) } satisfies ProdutoResponseBody,
    { status },
  );
}

function toBlingPayload(body: ProdutoRequest, categoriaBlingId: number | null): ProdutoBlingPayload {
  return {
    nome: body.nome,
    ...(body.codigo ? { codigo: body.codigo } : {}),
    preco: body.preco,
    tipo: body.tipo,
    situacao: body.situacao,
    formato: body.formato,
    unidade: body.unidade,
    ...(categoriaBlingId !== null ? { categoria: { id: categoriaBlingId } } : {}),
  };
}

/**
 * Timeout, conexão perdida ou abort chegam como exceção, não como
 * `BlingFailed`: sem esta conversão o ACK perdido virava `500` sem desfecho nem
 * auditoria. `status` `0` = nenhuma resposta legível, que não prova nada.
 */
async function semExcecao<T>(chamada: () => Promise<BlingCallResult<T>>): Promise<BlingCallResult<T>> {
  try {
    return await chamada();
  } catch (erro: unknown) {
    return blingFailure('UNKNOWN_ERROR', 0, descreverErro(erro));
  }
}

type ResolucaoBling =
  | {
      readonly _tag: 'Sincronizado';
      readonly blingId: string;
      readonly operacao: OperacaoNoBling;
      readonly saldo: DesfechoDoSaldo;
      readonly avisos: readonly string[];
    }
  /** Nada foi escrito no Bling: a consulta prévia por SKU falhou. */
  | { readonly _tag: 'NaoEnviado'; readonly response: NextResponse }
  | { readonly _tag: 'RecusadoPeloBling'; readonly operacao: OperacaoNoBling; readonly failure: BlingProviderFailure }
  | { readonly _tag: 'SemConfirmacao'; readonly operacao: OperacaoNoBling; readonly blingId: string | null; readonly failure: BlingProviderFailure };

/**
 * Garante o produto no Bling e devolve o id real.
 *
 * A ordem importa: o Bling é a fonte da verdade, então nada é gravado
 * localmente antes de ele confirmar.
 *
 * Uma falha só é recusa quando `classificarFalhaDeCriacaoNoBling` a reconhece
 * como recusa da requisição (`4xx` com tipo de validação/autorização). Timeout,
 * `5xx`, `429` ou sucesso sem id não provam que nada aconteceu lá: são
 * `SemConfirmacao`, e reenviar um cadastro nesse estado duplicaria o produto.
 */
async function garantirProdutoNoBling(
  body: ProdutoRequest,
  bling: ProdutoBlingPort,
  categoriaBlingId: number | null,
): Promise<ResolucaoBling> {
  const payload = toBlingPayload(body, categoriaBlingId);
  const avisos: string[] = [];

  let blingId = body.blingId ?? null;

  // Sem id conhecido, procura pelo SKU antes de criar — mas só aceita uma
  // correspondência de código exato.
  if (!blingId && body.codigo) {
    const encontrado = await bling.buscarPorCodigo(body.codigo);
    if (encontrado._tag === 'BlingFailed') {
      return { _tag: 'NaoEnviado', response: fail(`Não foi possível consultar o produto no Bling: ${encontrado.failure.message}`, 400) };
    }
    if (encontrado.value) {
      blingId = encontrado.value.id;
      avisos.push(`Produto já existia no Bling com o código ${body.codigo} (id ${blingId}); os dados foram atualizados.`);
    }
  }

  const existente = blingId;
  const operacao: OperacaoNoBling = existente ? 'atualizacao' : 'cadastro';
  if (existente) {
    const atualizado = await semExcecao(() => bling.atualizar(existente, payload));
    if (atualizado._tag === 'BlingFailed') return falhaNoBling(operacao, existente, atualizado.failure);
    blingId = existente;
  } else {
    const criado = await semExcecao(() => bling.criar(payload));
    if (criado._tag === 'BlingFailed') return falhaNoBling(operacao, null, criado.failure);
    blingId = criado.value.id;
  }
  const confirmado = blingId;

  // Balanço absoluto: repetir o mesmo valor não acumula. Só é pedido quando o
  // formulário mandou saldo — uma edição de nome não reaplica o saldo lido ao
  // abrir a tela, que desfaria vendas feitas nesse meio-tempo.
  let saldo: DesfechoDoSaldo = 'nao_solicitado';
  const quantidade = body.estoque;
  if (quantidade !== undefined) {
    const resultado = await semExcecao(() => bling.definirSaldo(confirmado, quantidade));
    saldo = resultado._tag === 'BlingOk' ? 'aplicado' : 'nao_confirmado';
    if (resultado._tag === 'BlingFailed') {
      avisos.push(`O produto ${confirmado} foi salvo no Bling, mas o saldo de estoque não foi confirmado: ${resultado.failure.message}. O estoque no ORBITA não foi alterado; sincronize para conferir.`);
    }
  }

  return { _tag: 'Sincronizado', blingId: confirmado, operacao, saldo, avisos };
}

function falhaNoBling(operacao: OperacaoNoBling, blingId: string | null, failure: BlingProviderFailure): ResolucaoBling {
  return classificarFalhaDeCriacaoNoBling(failure) === 'Definitiva'
    ? { _tag: 'RecusadoPeloBling', operacao, failure }
    : { _tag: 'SemConfirmacao', operacao, blingId, failure };
}

function respostaDaFalhaNoBling(resolucao: Extract<ResolucaoBling, { _tag: 'RecusadoPeloBling' | 'SemConfirmacao' }>): NextResponse {
  const { operacao, failure } = resolucao;
  if (resolucao._tag === 'RecusadoPeloBling') {
    return fail(operacao === 'cadastro'
      ? `O Bling recusou o cadastro do produto: ${failure.message}`
      : `O Bling recusou a atualização do produto: ${failure.message}`, 400);
  }
  return fail(operacao === 'cadastro'
    ? `O Bling não confirmou o cadastro do produto (${failure.message}) e ele pode ter sido criado. Não cadastre de novo: sincronize o catálogo e confira antes.`
    : `O Bling não confirmou a atualização do produto (${failure.message}). Nada foi gravado no ORBITA; sincronize o catálogo e confira antes de editar de novo.`,
  502, { motivo: 'bling_sem_confirmacao', blingId: resolucao.blingId });
}

/** Auditoria sem mudar a resposta: o desfecho no Bling já está decidido. */
async function auditarSemInterromper(
  deps: ProdutoDependencies,
  scope: VerifiedOrganizationScope,
  evento: EventoDoProduto,
): Promise<void> {
  try {
    await deps.auditar(scope, evento);
  } catch (erro: unknown) {
    registrarFalhaInterna(`produtos.update.auditoria.${evento.acao}`, erro, { organizacaoId: scope.organizationId, atorId: scope.actorId });
  }
}

function eventoDaFalhaNoBling(
  resolucao: Extract<ResolucaoBling, { _tag: 'RecusadoPeloBling' | 'SemConfirmacao' }>,
  recursoId: string | null,
  correlationId: string,
): EventoDoProduto {
  return resolucao._tag === 'RecusadoPeloBling'
    ? {
        acao: 'catalog.product_save_rejected',
        recursoId,
        correlationId,
        metadata: { operacao: resolucao.operacao, tipo_erro: resolucao.failure.type, status_http: resolucao.failure.status },
      }
    : {
        acao: 'catalog.product_reconcile_required',
        recursoId,
        correlationId,
        metadata: { operacao: resolucao.operacao, motivo: 'bling_sem_confirmacao', bling_id: resolucao.blingId },
      };
}

/** O Bling confirmou: espelha no ORBITA, com o saldo só se ele também foi confirmado. */
async function espelharNoOrbita(
  deps: ProdutoDependencies,
  scope: VerifiedOrganizationScope,
  body: ProdutoRequest,
  resolucao: Extract<ResolucaoBling, { _tag: 'Sincronizado' }>,
  correlationId: string,
): Promise<NextResponse> {
  try {
    const product = await deps.store.upsert(scope, {
      id: body.id,
      blingId: resolucao.blingId,
      nome: body.nome,
      codigo: body.codigo ?? null,
      preco: body.preco,
      ...(resolucao.saldo === 'aplicado' && body.estoque !== undefined ? { estoque: body.estoque } : {}),
      categoriaId: body.categoriaId,
    });

    await auditarSemInterromper(deps, scope, {
      acao: 'catalog.product_saved',
      recursoId: product.id,
      correlationId,
      metadata: { produto_id: product.id, bling_id: resolucao.blingId, operacao: resolucao.operacao, saldo: resolucao.saldo },
    });
    return NextResponse.json(
      { success: true, product, avisos: resolucao.avisos, saldo: resolucao.saldo } satisfies ProdutoResponseBody,
      { status: 200 },
    );
  } catch (error: unknown) {
    await auditarSemInterromper(deps, scope, {
      acao: 'catalog.product_reconcile_required',
      recursoId: body.id ?? null,
      correlationId,
      metadata: { operacao: resolucao.operacao, motivo: 'espelho_local_falhou', bling_id: resolucao.blingId },
    });
    const causa = descreverErro(error);
    // O produto já existe no Bling neste ponto; dizer isso é o que permite
    // reconciliar em vez de reenviar e duplicar.
    return fail(
      `Produto salvo no Bling (id ${resolucao.blingId}), mas falhou ao gravar no ORBITA: ${causa}. Sincronize o catálogo para reconciliar.`,
      500,
      { motivo: 'espelho_local_falhou', blingId: resolucao.blingId },
    );
  }
}

/**
 * `POST /api/produtos/update`.
 *
 * Cadastra ou atualiza o produto no Bling e só então espelha no cache local,
 * com o id real do ERP. Nenhum identificador nem SKU é inventado.
 */
export function createProdutoUpdateHandler(deps: ProdutoDependencies) {
  return async function handleProdutoUpdate(request: Request): Promise<NextResponse> {
    const authorization = await deps.auth.authorize(request);
    if (authorization._tag === 'Denied') return authorization.response;
    const { scope } = authorization;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return fail('Corpo da requisição não é um JSON válido.', 400);
    }

    const parsed = produtoRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const detalhes = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`).join('; ');
      return fail(`Produto inválido: ${detalhes}`, 400);
    }
    const body = parsed.data;

    // Antes de qualquer escrita no ERP: sem categoria resolvida não se cria
    // nem se atualiza nada, porque o produto iria para lá sem a categoria que a
    // pessoa escolheu, ou com uma que não é dela.
    let categoriaBlingId: number | null = null;
    if (body.categoriaId !== undefined) {
      categoriaBlingId = await deps.categorias.resolverBlingId(scope, body.categoriaId);
      if (categoriaBlingId === null) {
        return fail('Categoria não encontrada nesta organização, ou sem vínculo com o Bling. Sincronize as categorias e escolha novamente.', 400);
      }
    }

    const correlationId = deps.correlationId(request);
    const resolucao = await garantirProdutoNoBling(body, deps.bling, categoriaBlingId);
    if (resolucao._tag === 'NaoEnviado') return resolucao.response;
    if (resolucao._tag !== 'Sincronizado') {
      await auditarSemInterromper(deps, scope, eventoDaFalhaNoBling(resolucao, body.id ?? null, correlationId));
      return respostaDaFalhaNoBling(resolucao);
    }
    return espelharNoOrbita(deps, scope, body, resolucao, correlationId);
  };
}
