import { NextResponse } from 'next/server';

import { MENSAGEM_PUBLICA_DE_FALHA, registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { lerTriagemDoCaso } from '@/services/sac/leituraDaTriagem';

import { criarRotaDaTriagem } from './handlers';

export const dynamic = 'force-dynamic';

const lerTriagem = criarRotaDaTriagem({
  resolverContexto: resolveActiveRequestOrganizationContext,
  ler: (scope, conversaId) => lerTriagemDoCaso(supabaseServer, scope, conversaId),
});

/** A triagem por IA do caso atual da conversa (MSG-013). Hipótese, só leitura. */
export async function GET(request: Request) {
  try {
    return await lerTriagem(request);
  } catch (erro: unknown) {
    registrarFalhaInterna('sac.triagem.ler', erro);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
