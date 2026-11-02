import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { dependenciasDaOutbox } from '../dependencias';
import { criarDecisaoDaOutbox } from '../handlers';

export const dynamic = 'force-dynamic';

const decidir = criarDecisaoDaOutbox(dependenciasDaOutbox);

/** Reconciliar um envio desconhecido ou autorizar o replay de um provado não aplicado. */
export async function POST(request: Request, { params }: { params: Promise<{ eventoId: string }> }) {
  try {
    const { eventoId } = await params;
    return await decidir(request, eventoId);
  } catch (err: unknown) {
    registrarFalhaInterna('integracoes.outbox.decidir', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
