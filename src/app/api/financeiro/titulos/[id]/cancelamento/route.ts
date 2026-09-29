import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { createCancelamentoDeDespesaHandler } from '../../correcaoDeTitulo';
import { dependenciasDaCorrecaoDeTitulo } from '../../dependencias';

export const dynamic = 'force-dynamic';

const cancelarDespesa = createCancelamentoDeDespesaHandler(dependenciasDaCorrecaoDeTitulo);

/** Cancela uma despesa do Bling depois de ler a situação real lá. Ver `correcaoDeTitulo.ts`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return await cancelarDespesa(request, id);
  } catch (err: unknown) {
    registrarFalhaInterna('financeiro.cancelar-despesa', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
