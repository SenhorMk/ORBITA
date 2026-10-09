import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { operacoesHandlers } from '../dependencias';

export const dynamic = 'force-dynamic';

/** Uma operação de conta a pagar pela `operation_ref`, na organização da sessão. */
export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const { ref } = await params;
    return await operacoesHandlers.consultar(request, ref);
  } catch (err: unknown) {
    registrarFalhaInterna('financeiro.operacoes.consultar', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
