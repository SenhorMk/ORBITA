import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import { dependenciasDaOutbox } from './dependencias';
import { criarConsultaDaOutbox } from './handlers';

export const dynamic = 'force-dynamic';

const consultar = criarConsultaDaOutbox(dependenciasDaOutbox);

/** Envios que pedem atenção na organização da sessão, com as tentativas. */
export async function GET(request: Request) {
  try {
    return await consultar(request);
  } catch (err: unknown) {
    registrarFalhaInterna('integracoes.outbox.consultar', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
