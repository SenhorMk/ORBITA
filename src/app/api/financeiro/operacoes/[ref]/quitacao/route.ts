import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { operacoesHandlers } from '../../dependencias';

export const dynamic = 'force-dynamic';

/** Quitação explícita de uma operação cujo lançamento a pediu. Ver `reconciliacaoDaOperacao.ts`. */
export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const { ref } = await params;
    return await operacoesHandlers.quitar(request, ref);
  } catch (err: unknown) {
    registrarFalhaInterna('financeiro.operacoes.quitacao', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
