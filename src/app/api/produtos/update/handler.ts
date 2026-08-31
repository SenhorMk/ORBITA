import { NextResponse } from 'next/server';

import { produtoRequestSchema, type ProdutoRequest } from '@/lib/config/produtoContract';
import type { BlingCallResult } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { descreverErro } from '@/lib/erroLegivel';

/** Produto como o Bling o descreve, reduzido ao que esta fatia precisa. */
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
    readonly estoque: number;
    readonly categoriaId?: string;
  }): Promise<ProdutoPersistido>;
}

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
}

export interface ProdutoResponseBody {
  readonly success: boolean;
  readonly product?: ProdutoPersistido;
  readonly avisos?: readonly string[];
  readonly error?: string;
}

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error } satisfies ProdutoResponseBody, { status });
}

function toBlingPayload(body: ProdutoRequest): ProdutoBlingPayload {
  return {
    nome: body.nome,
    ...(body.codigo ? { codigo: body.codigo } : {}),
    preco: body.preco,
    tipo: body.tipo,
    situacao: body.situacao,
    formato: body.formato,
    unidade: body.unidade,
  };
}

type ResolucaoBling =
  | { readonly _tag: 'Sincronizado'; readonly blingId: string; readonly avisos: readonly string[] }
  | { readonly _tag: 'Recusado'; readonly response: NextResponse };

/**
 * Garante o produto no Bling e devolve o id real.
 *
 * A ordem importa: o Bling é a fonte da verdade, então nada é gravado
 * localmente antes de ele confirmar.
 */
async function garantirProdutoNoBling(
  body: ProdutoRequest,
  bling: ProdutoBlingPort,
): Promise<ResolucaoBling> {
  const payload = toBlingPayload(body);
  const avisos: string[] = [];

  let blingId = body.blingId ?? null;

  // Sem id conhecido, procura pelo SKU antes de criar — mas só aceita uma
  // correspondência de código exato.
  if (!blingId && body.codigo) {
    const encontrado = await bling.buscarPorCodigo(body.codigo);
    if (encontrado._tag === 'BlingFailed') {
      return { _tag: 'Recusado', response: fail(`Não foi possível consultar o produto no Bling: ${encontrado.failure.message}`, 400) };
    }
    if (encontrado.value) {
      blingId = encontrado.value.id;
      avisos.push(`Produto já existia no Bling com o código ${body.codigo} (id ${blingId}); os dados foram atualizados.`);
    }
  }

  if (blingId) {
    const atualizado = await bling.atualizar(blingId, payload);
    if (atualizado._tag === 'BlingFailed') {
      return { _tag: 'Recusado', response: fail(`O Bling recusou a atualização do produto: ${atualizado.failure.message}`, 400) };
    }
  } else {
    const criado = await bling.criar(payload);
    if (criado._tag === 'BlingFailed') {
      return { _tag: 'Recusado', response: fail(`O Bling recusou o cadastro do produto: ${criado.failure.message}`, 400) };
    }
    blingId = criado.value.id;
  }

  if (body.estoque !== undefined) {
    const saldo = await bling.definirSaldo(blingId, body.estoque);
    if (saldo._tag === 'BlingFailed') {
      avisos.push(`O produto ${blingId} foi salvo no Bling, mas o saldo de estoque não foi aplicado: ${saldo.failure.message}.`);
    }
  }

  return { _tag: 'Sincronizado', blingId, avisos };
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

    const resolucao = await garantirProdutoNoBling(body, deps.bling);
    if (resolucao._tag === 'Recusado') return resolucao.response;

    try {
      const product = await deps.store.upsert(scope, {
        id: body.id,
        blingId: resolucao.blingId,
        nome: body.nome,
        codigo: body.codigo ?? null,
        preco: body.preco,
        estoque: body.estoque ?? 0,
        categoriaId: body.categoriaId,
      });

      return NextResponse.json(
        { success: true, product, avisos: resolucao.avisos } satisfies ProdutoResponseBody,
        { status: 200 },
      );
    } catch (error: unknown) {
      const causa = descreverErro(error);
      // O produto já existe no Bling neste ponto; dizer isso é o que permite
      // reconciliar em vez de reenviar e duplicar.
      return fail(
        `Produto salvo no Bling (id ${resolucao.blingId}), mas falhou ao gravar no ORBITA: ${causa}. Sincronize o catálogo para reconciliar.`,
        500,
      );
    }
  };
}
