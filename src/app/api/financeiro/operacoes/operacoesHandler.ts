import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { OperacaoFinanceira } from '@/lib/config/operacaoFinanceiraContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import {
  reconciliarOperacao,
  type OperacaoRegistrada,
  type ReconciliacaoDependencies,
} from '../reconciliacaoDaOperacao';

/** Composição das rotas de operações financeiras. */
export interface OperacoesDependencies extends ReconciliacaoDependencies {
  /** Autentica e exige a capacidade de administrar a organização. */
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly correlationId: (request: Request) => string;
}

const refSchema = z.string().uuid();

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
    ultimaReconciliacao: operacao.ultimaReconciliacao,
  };
}

/**
 * Handlers de `GET /api/financeiro/operacoes`, `GET .../{ref}` e
 * `POST .../{ref}/reconciliar`.
 *
 * A autorização vem antes de qualquer leitura. A `operation_ref` não dá acesso
 * por si: toda leitura filtra a organização do escopo verificado, e a operação
 * de outra organização é indistinguível de uma inexistente (404).
 *
 * @param deps - Composição real ou de teste.
 * @returns Os três handlers.
 */
export function createOperacoesHandlers(deps: OperacoesDependencies) {
  return {
    async listar(request: Request): Promise<NextResponse> {
      const autorizacao = await deps.autorizar(request);
      if (autorizacao._tag === 'Negado') return autorizacao.response;
      const lidas = await deps.operacoes.listarPendentes(autorizacao.scope);
      if (lidas._tag !== 'Listadas') return INDISPONIVEL();
      return NextResponse.json({ success: true, operacoes: lidas.operacoes.map(publica) });
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
      const resultado = await reconciliarOperacao(autorizacao.scope, ref, deps.correlationId(request), deps);
      if (resultado._tag === 'NaoEncontrada') return NAO_ENCONTRADA();
      if (resultado._tag !== 'Reconciliada') return INDISPONIVEL();
      return NextResponse.json({
        success: true,
        resultado: resultado.resultado,
        motivo: resultado.motivo,
        operacao: publica(resultado.operacao),
      });
    },
  };
}
