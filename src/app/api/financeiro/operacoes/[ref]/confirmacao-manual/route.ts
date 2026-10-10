import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { operacoesHandlers } from '../../dependencias';

export const dynamic = 'force-dynamic';

/** Confirmação manual: o servidor lê a conta apontada por id e só aceita se ela conferir. Ver `reconciliacaoDaOperacao.ts`. */
export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const { ref } = await params;
    return await operacoesHandlers.confirmarManual(request, ref);
  } catch (err: unknown) {
    registrarFalhaInterna('financeiro.operacoes.confirmacao_manual', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
