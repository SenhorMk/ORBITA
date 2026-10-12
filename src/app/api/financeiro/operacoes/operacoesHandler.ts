import { NextResponse } from 'next/server';
import { z } from 'zod';

import { confirmacaoManualSchema, type OperacaoFinanceira } from '@/lib/config/operacaoFinanceiraContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import {
  confirmarManualmente,
  quitarOperacao,
  reconciliarOperacao,
  type OperacaoRegistrada,
  type CursorDePendencias,
  type QuitacaoDaOperacaoDependencies,
  type ResultadoDaReconciliacao,
} from '../reconciliacaoDaOperacao';
import { pendenciaDaOperacao } from '../reconciliacaoDeContaPagar';

/** Composição das rotas de operações financeiras. */
export interface OperacoesDependencies extends QuitacaoDaOperacaoDependencies {
  /** Autentica e exige a capacidade de administrar a organização. */
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly correlationId: (request: Request) => string;
}

const refSchema = z.string().uuid();

/** O cursor público é opaco: `criação|chave` em base64url. Só posiciona; a organização vem da sessão. */
const cursorSchema = z.object({
  criadaEm: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/u),
  ref: z.string().uuid(),
});

function codificarCursor(cursor: CursorDePendencias): string {
  return Buffer.from(`${cursor.criadaEm}|${cursor.ref}`, 'utf8').toString('base64url');
}

function decodificarCursor(bruto: string): CursorDePendencias | null {
  const [criadaEm, ref, ...resto] = Buffer.from(bruto, 'base64url').toString('utf8').split('|');
  const lido = cursorSchema.safeParse({ criadaEm, ref });
  return lido.success && resto.length === 0 ? lido.data : null;
}

const falha = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });
const NAO_ENCONTRADA = () => falha('Operação não encontrada.', 404);
const INDISPONIVEL = () => falha('Não foi possível consultar a operação agora. Tente de novo em instantes.', 503);

/** Projeta a operação para o contrato público: sem ids internos nem referência do Bling. */
function publica(operacao: OperacaoRegistrada): OperacaoFinanceira {
  return {
    ref: operacao.ref,
    criacao: operacao.estado,
    baixa: operacao.baixa?.estado ?? null,
    valor: operacao.valor,
    dataVencimento: operacao.dataVencimento,
    blingContaId: operacao.blingContaId,
    quitacaoSolicitada: operacao.quitacaoSolicitada,
    pendencia: pendenciaDaOperacao(operacao),
    ultimaReconciliacao: operacao.ultimaReconciliacao,
  };
}

function respostaDaReconciliacao(resultado: ResultadoDaReconciliacao): NextResponse {
  if (resultado._tag === 'NaoEncontrada') return NAO_ENCONTRADA();
  if (resultado._tag !== 'Reconciliada') return INDISPONIVEL();
  return NextResponse.json({
    success: true,
    resultado: resultado.resultado,
    motivo: resultado.motivo,
    projecaoLocal: resultado.projecaoLocal,
    operacao: publica(resultado.operacao),
  });
}

/**
 * Handlers de `GET /api/financeiro/operacoes`, `GET .../{ref}`,
 * `POST .../{ref}/reconciliar`, `POST .../{ref}/confirmacao-manual` e
 * `POST .../{ref}/quitacao`.
 *
 * A autorização vem antes de qualquer leitura. A `operation_ref` não dá acesso
 * por si: toda leitura filtra a organização do escopo verificado, e a operação
 * de outra organização é indistinguível de uma inexistente (404).
 *
 * @param deps - Composição real ou de teste.
 * @returns Os handlers.
 */
export function createOperacoesHandlers(deps: OperacoesDependencies) {
  return {
    async listar(request: Request): Promise<NextResponse> {
      const autorizacao = await deps.autorizar(request);
      if (autorizacao._tag === 'Negado') return autorizacao.response;
      const bruto = new URL(request.url).searchParams.get('cursor');
      const apos = bruto === null ? undefined : decodificarCursor(bruto);
      if (apos === null) return falha('Cursor inválido.', 400);
      const lidas = await deps.operacoes.listarPendentes(autorizacao.scope, apos);
      if (lidas._tag !== 'Listadas') return INDISPONIVEL();
      return NextResponse.json({
        success: true,
        operacoes: lidas.operacoes.map(publica),
        total: lidas.total,
        incompleta: lidas.proximo !== null,
        proximoCursor: lidas.proximo === null ? null : codificarCursor(lidas.proximo),
      });
    },

    async consultar(request: Request, ref: string): Promise<NextResponse> {
      const autorizacao = await deps.autorizar(request);
      if (autorizacao._tag === 'Negado') return autorizacao.response;
      if (!refSchema.safeParse(ref).success) return falha('Operação inválida.', 400);
      const lida = await deps.operacoes.lerOperacao(autorizacao.scope, ref);
      if (lida._tag === 'NaoEncontrada') return NAO_ENCONTRADA();
      if (lida._tag !== 'Encontrada') return INDISPONIVEL();
      return NextResponse.json({ success: true, operacao: publica(lida.operacao) });
    },

    async reconciliar(request: Request, ref: string): Promise<NextResponse> {
      const autorizacao = await deps.autorizar(request);
      if (autorizacao._tag === 'Negado') return autorizacao.response;
      if (!refSchema.safeParse(ref).success) return falha('Operação inválida.', 400);
      return respostaDaReconciliacao(await reconciliarOperacao(autorizacao.scope, ref, deps.correlationId(request), deps));
    },

    async confirmarManual(request: Request, ref: string): Promise<NextResponse> {
      const autorizacao = await deps.autorizar(request);
      if (autorizacao._tag === 'Negado') return autorizacao.response;
      if (!refSchema.safeParse(ref).success) return falha('Operação inválida.', 400);
      const corpo = confirmacaoManualSchema.safeParse(await request.json().catch(() => null));
      if (!corpo.success) return falha('Informe o número da conta no Bling.', 400);
      return respostaDaReconciliacao(await confirmarManualmente(
        autorizacao.scope, ref, corpo.data.blingContaId, deps.correlationId(request), deps,
        { declaracaoDoOperador: corpo.data.declaracaoDoOperador },
      ));
    },

    async quitar(request: Request, ref: string): Promise<NextResponse> {
      const autorizacao = await deps.autorizar(request);
      if (autorizacao._tag === 'Negado') return autorizacao.response;
      if (!refSchema.safeParse(ref).success) return falha('Operação inválida.', 400);
      const resultado = await quitarOperacao(autorizacao.scope, ref, deps.correlationId(request), deps);
      if (resultado._tag === 'NaoEncontrada') return NAO_ENCONTRADA();
      if (resultado._tag !== 'Reconciliada') return INDISPONIVEL();
      return NextResponse.json({
        success: true,
        resultado: resultado.resultado,
        projecaoLocal: resultado.projecaoLocal,
        operacao: publica(resultado.operacao),
      });
    },
  };
}
