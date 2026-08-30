import { NextResponse } from 'next/server';

import { despesaRequestSchema, type DespesaRequest } from '@/lib/config/despesaContract';
import type { BlingCallResult } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

export interface ContaPagarPayload {
  readonly contatoId: number;
  readonly vencimento: string;
  readonly valor: number;
  readonly historico: string;
  readonly dataEmissao: string;
  readonly competencia: string;
  readonly categoriaId?: number;
}

export interface DespesaBlingPort {
  /** Contato/fornecedor a usar quando o cliente não informa um. */
  resolverContatoPadrao(): Promise<BlingCallResult<number>>;
  criarContaPagar(payload: ContaPagarPayload): Promise<BlingCallResult<{ id: string }>>;
  /** Conta financeira (`portador`), obrigatória para quitar. */
  obterPortadorPadrao(): Promise<BlingCallResult<number>>;
  baixarContaPagar(id: string, payload: {
    data: string;
    historico: string;
    portadorId: number;
    categoriaId: number;
  }): Promise<BlingCallResult<void>>;
}

export interface TituloPersistido {
  readonly id: string;
  readonly blingId: string | null;
  readonly situacao: string;
}

export interface DespesaStorePort {
  /** Traduz a categoria local para o id da categoria no Bling. */
  resolverCategoriaBling(scope: VerifiedOrganizationScope, categoriaId: string): Promise<number | null>;
  salvarTitulo(scope: VerifiedOrganizationScope, titulo: {
    readonly blingId: string | null;
    readonly valor: number;
    readonly dataVencimento: string;
    readonly descricao: string;
    readonly categoriaId?: string;
    readonly situacao: 'aberto' | 'pago';
  }): Promise<TituloPersistido>;
}

export interface DespesaAuthPort {
  authorize(request: Request): Promise<
    | { readonly _tag: 'Authorized'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Denied'; readonly response: NextResponse }
  >;
}

export interface DespesaDependencies {
  readonly auth: DespesaAuthPort;
  readonly bling: DespesaBlingPort;
  readonly store: DespesaStorePort;
  /** Data de hoje em `America/Sao_Paulo`, no formato AAAA-MM-DD. */
  readonly hoje: () => string;
}

export interface DespesaResponseBody {
  readonly success: boolean;
  readonly data?: TituloPersistido;
  readonly avisos?: readonly string[];
  readonly error?: string;
}

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error } satisfies DespesaResponseBody, { status });
}

type SincronizacaoBling =
  | { readonly _tag: 'Sincronizada'; readonly blingId: string; readonly quitada: boolean; readonly avisos: readonly string[] }
  | { readonly _tag: 'Recusada'; readonly response: NextResponse };

/**
 * Cria a conta a pagar no Bling e, quando a despesa é marcada como paga,
 * quita-a pelo endpoint próprio.
 *
 * A quitação é um passo separado porque `situacao` é `readOnly` na criação: a
 * versão anterior mandava `situacao: 2` e gravava `'pago'` localmente, então a
 * conta ficava **aberta no ERP e quitada no ORBITA**.
 */
async function sincronizarComBling(
  body: DespesaRequest,
  categoriaBlingId: number | null,
  deps: DespesaDependencies,
): Promise<SincronizacaoBling> {
  let contatoId = body.contatoBlingId ?? null;
  if (contatoId === null) {
    const padrao = await deps.bling.resolverContatoPadrao();
    if (padrao._tag === 'BlingFailed') {
      return { _tag: 'Recusada', response: fail(`Não foi possível resolver o fornecedor no Bling: ${padrao.failure.message}`, 400) };
    }
    contatoId = padrao.value;
  }

  const hoje = deps.hoje();
  const criada = await deps.bling.criarContaPagar({
    contatoId,
    vencimento: body.dataVencimento,
    valor: body.valor,
    historico: body.descricao,
    dataEmissao: hoje,
    competencia: hoje,
    ...(categoriaBlingId ? { categoriaId: categoriaBlingId } : {}),
  });

  if (criada._tag === 'BlingFailed') {
    return { _tag: 'Recusada', response: fail(`O Bling recusou o lançamento: ${criada.failure.message}`, 400) };
  }

  const blingId = criada.value.id;
  if (!body.pago) {
    return { _tag: 'Sincronizada', blingId, quitada: false, avisos: [] };
  }

  if (!categoriaBlingId) {
    return {
      _tag: 'Sincronizada',
      blingId,
      quitada: false,
      avisos: [`A despesa ${blingId} foi lançada no Bling, mas não pôde ser quitada: a quitação exige uma categoria sincronizada com o Bling.`],
    };
  }

  const portador = await deps.bling.obterPortadorPadrao();
  if (portador._tag === 'BlingFailed') {
    return {
      _tag: 'Sincronizada',
      blingId,
      quitada: false,
      avisos: [`A despesa ${blingId} foi lançada no Bling, mas continua em aberto lá: ${portador.failure.message}`],
    };
  }

  const baixa = await deps.bling.baixarContaPagar(blingId, {
    data: hoje,
    historico: body.descricao,
    portadorId: portador.value,
    categoriaId: categoriaBlingId,
  });

  if (baixa._tag === 'BlingFailed') {
    return {
      _tag: 'Sincronizada',
      blingId,
      quitada: false,
      avisos: [`A despesa ${blingId} foi lançada no Bling, mas a quitação falhou: ${baixa.failure.message}. Ela continua em aberto no ERP.`],
    };
  }

  return { _tag: 'Sincronizada', blingId, quitada: true, avisos: [] };
}

/**
 * `POST /api/financeiro` — lançamento de despesa.
 *
 * No modo `contabil` o Bling é a fonte da verdade: nada é gravado localmente
 * antes de ele confirmar, e a situação registrada aqui é a que o ERP tem de
 * fato, não a que o formulário pediu.
 */
export function createDespesaHandler(deps: DespesaDependencies) {
  return async function handleDespesa(request: Request): Promise<NextResponse> {
    const authorization = await deps.auth.authorize(request);
    if (authorization._tag === 'Denied') return authorization.response;
    const { scope } = authorization;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return fail('Corpo da requisição não é um JSON válido.', 400);
    }

    const parsed = despesaRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const detalhes = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`).join('; ');
      return fail(`Despesa inválida: ${detalhes}`, 400);
    }
    const body = parsed.data;

    const categoriaBlingId = body.categoriaId
      ? await deps.store.resolverCategoriaBling(scope, body.categoriaId)
      : null;

    if (body.modo === 'interno') {
      const data = await deps.store.salvarTitulo(scope, {
        blingId: null,
        valor: body.valor,
        dataVencimento: body.dataVencimento,
        descricao: body.descricao,
        categoriaId: body.categoriaId,
        situacao: body.pago ? 'pago' : 'aberto',
      });
      return NextResponse.json({ success: true, data } satisfies DespesaResponseBody, { status: 200 });
    }

    const sincronizacao = await sincronizarComBling(body, categoriaBlingId, deps);
    if (sincronizacao._tag === 'Recusada') return sincronizacao.response;

    try {
      const data = await deps.store.salvarTitulo(scope, {
        blingId: sincronizacao.blingId,
        valor: body.valor,
        dataVencimento: body.dataVencimento,
        descricao: body.descricao,
        categoriaId: body.categoriaId,
        // A situação gravada é a real do ERP. Se a quitação não aconteceu, o
        // título fica aberto aqui também — os dois lados contam a mesma coisa.
        situacao: sincronizacao.quitada ? 'pago' : 'aberto',
      });

      return NextResponse.json(
        { success: true, data, avisos: sincronizacao.avisos } satisfies DespesaResponseBody,
        { status: 200 },
      );
    } catch (error: unknown) {
      const causa = error instanceof Error ? error.message : String(error);
      return fail(
        `Despesa lançada no Bling (id ${sincronizacao.blingId}), mas falhou ao gravar no ORBITA: ${causa}. Sincronize o financeiro para reconciliar.`,
        500,
      );
    }
  };
}
