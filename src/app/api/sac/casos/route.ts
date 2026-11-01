import { NextResponse } from 'next/server';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { listarCasos, listarEventosRecebidos } from '@/services/sac/leituraDeCasos';

import { criarConsultaDeCasos } from './handlers';

export const dynamic = 'force-dynamic';

const consultar = criarConsultaDeCasos({
  resolverContexto: resolveActiveRequestOrganizationContext,
  listarEventos: (scope) => listarEventosRecebidos(supabaseServer, scope),
  listarCasos: (scope) => listarCasos(supabaseServer, scope),
});

/** Só GET: esta rota não aciona o consumidor; nenhuma rota aciona. */
export async function GET(request: Request) {
  try {
    return await consultar(request);
  } catch (err: unknown) {
    registrarFalhaInterna('sac.casos.consultar', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
