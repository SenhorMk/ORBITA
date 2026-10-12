import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { operacoesHandlers } from './dependencias';

export const dynamic = 'force-dynamic';

/** Operações de conta a pagar com resultado ainda não confirmado. Ver `operacoesHandler.ts`. */
export async function GET(request: Request) {
  try {
    return await operacoesHandlers.listar(request);
  } catch (err: unknown) {
    registrarFalhaInterna('financeiro.operacoes.listar', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
