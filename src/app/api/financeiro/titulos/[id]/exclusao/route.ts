import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { createExclusaoDeLancamentoHandler } from '../../correcaoDeTitulo';
import { dependenciasDaCorrecaoDeTitulo } from '../../dependencias';

export const dynamic = 'force-dynamic';

const excluirLancamento = createExclusaoDeLancamentoHandler(dependenciasDaCorrecaoDeTitulo);

/** Exclui um lançamento de despesa puramente interno. Ver `correcaoDeTitulo.ts`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return await excluirLancamento(request, id);
  } catch (err: unknown) {
    registrarFalhaInterna('financeiro.excluir-lancamento', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
