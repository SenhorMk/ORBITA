import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { operacoesHandlers } from '../../dependencias';

export const dynamic = 'force-dynamic';

/** Confere a operação no Bling (só leitura) e grava o recibo. Ver `reconciliacaoDaOperacao.ts`. */
export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const { ref } = await params;
    return await operacoesHandlers.reconciliar(request, ref);
  } catch (err: unknown) {
    registrarFalhaInterna('financeiro.operacoes.reconciliar', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
