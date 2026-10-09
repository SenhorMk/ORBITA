import { NextResponse } from 'next/server';

import { despesaRequestSchema, type OperacaoDeDespesa } from '@/lib/config/despesaContract';
import type { EnvioDeCriacaoAoBling } from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import type { BlingCallResult } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fail, lancarNoBling } from './lancamentoContabil';

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
  /**
   * `POST /contas/pagar`. Relata fatos: `NaoEnviado` só quando nenhuma
   * requisição saiu; `Despachado` com o que voltou em todo o resto.
   */
  criarContaPagar(payload: ContaPagarPayload): Promise<EnvioDeCriacaoAoBling<{ id: string }>>;
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
  /**
   * O que a gravação não conseguiu registrar, quando conseguiu gravar o resto.
   *
   * Existe para um caso concreto: a migration que criou `titulo` e o
   * fornecedor pode ainda não ter sido aplicada no banco em que esta versão
   * está rodando. A despesa é gravada do mesmo jeito — o valor, a data e a
   * situação são o que importa —, e o aviso diz o que ficou de fora e por quê,
   * em vez de a informação sumir em silêncio.
   */
  readonly aviso?: string;
}

/** A intenção de criar a conta a pagar, registrada antes do POST. */
export interface IntencaoDeContaPagar {
  readonly chave: string;
  readonly digest: string;
  readonly valor: number;
  readonly dataVencimento: string;
  readonly dataEmissao: string;
  /** O contato informado pelo cliente; `null` quando o servidor vai resolver. */
  readonly contatoBlingId: number | null;
}

/**
 * Resultado de reivindicar a chave da operação. Só `TentativaPropria` autoriza
 * o POST; todos os outros casos respondem sem chamar o Bling.
 */
export type ReivindicacaoDeTentativa =
  | { readonly _tag: 'TentativaPropria'; readonly tentativaId: string; readonly epoca: number }
  | {
      readonly _tag: 'TentativaRepetida';
      readonly tentativaId: string;
      readonly estado: 'em_voo' | 'confirmada' | 'recusada' | 'indeterminada';
      readonly blingContaId: string | null;
      readonly tituloId: string | null;
      readonly contatoBlingId: number | null;
    }
  | { readonly _tag: 'ConflitoDeConteudo' }
  | { readonly _tag: 'PendenciaIdentica'; readonly chavePendente: string }
  /** Não deu para reivindicar. Falha fechada: o Bling não é chamado. */
  | { readonly _tag: 'TentativaIndisponivel' };

/** O desfecho gravado por quem reivindicou, na época em que reivindicou. */
export type DesfechoDaTentativa =
  | {
      readonly estado: 'nao_enviada' | 'recusada' | 'indeterminada';
      readonly motivo: string;
      readonly contatoBlingId: number | null;
    }
  | { readonly estado: 'confirmada'; readonly blingContaId: string; readonly contatoBlingId: number };

/** `NaoGravado` cobre falha de banco e época vencida: nos dois, nada mudou. */
export type GravacaoDeTentativa = 'Gravado' | 'NaoGravado';

export interface DespesaStorePort {
  /** Traduz a categoria local para o id da categoria no Bling. */
  resolverCategoriaBling(scope: VerifiedOrganizationScope, categoriaId: string): Promise<number | null>;
  salvarTitulo(scope: VerifiedOrganizationScope, titulo: {
    readonly blingId: string | null;
    readonly valor: number;
    readonly dataVencimento: string;
    /** Nome curto local. Ausente quando o lançamento não informou um. */
    readonly titulo?: string;
    readonly descricao: string;
    readonly categoriaId?: string;
    readonly situacao: 'aberto' | 'pago';
    /** O contato do ERP a quem a despesa foi lançada, e o nome dele na hora. */
    readonly fornecedorBlingId?: number;
    readonly fornecedorNome?: string;
  }): Promise<TituloPersistido>;
  reivindicarTentativa(scope: VerifiedOrganizationScope, intencao: IntencaoDeContaPagar): Promise<ReivindicacaoDeTentativa>;
  /** Compare-and-set: só grava se a tentativa ainda está `em_voo` nesta época. */
  concluirTentativa(
    scope: VerifiedOrganizationScope,
    tentativa: { readonly tentativaId: string; readonly epoca: number },
    desfecho: DesfechoDaTentativa,
  ): Promise<GravacaoDeTentativa>;
  vincularTitulo(scope: VerifiedOrganizationScope, tentativaId: string, tituloId: string): Promise<GravacaoDeTentativa>;
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
  /** Chave para um cliente que não mandou a sua. */
  readonly novaChave: () => string;
}

export interface DespesaResponseBody {
  readonly success: boolean;
  readonly data?: TituloPersistido;
  readonly avisos?: readonly string[];
  readonly error?: string;
  /** Presente no modo contábil sempre que existe uma operação a referenciar. */
  readonly operacao?: OperacaoDeDespesa;
}

/**
 * `POST /api/financeiro` — lançamento de despesa.
 *
 * No modo `contabil` o Bling é a fonte da verdade: o título local só é gravado
 * depois de o Bling confirmar, e a situação registrada aqui é a que o ERP tem
 * de fato. Antes do POST, porém, a INTENÇÃO já está gravada: é ela que impede
 * uma resposta perdida de virar uma segunda conta a pagar.
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
        titulo: body.titulo,
        descricao: body.descricao,
        categoriaId: body.categoriaId,
        situacao: body.pago ? 'pago' : 'aberto',
      });
      return NextResponse.json(
        { success: true, data, ...(data.aviso ? { avisos: [data.aviso] } : {}) } satisfies DespesaResponseBody,
        { status: 200 },
      );
    }

    return lancarNoBling(scope, body, categoriaBlingId, deps);
  };
}
