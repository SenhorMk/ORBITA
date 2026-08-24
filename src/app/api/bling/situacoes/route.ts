import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { verifySessionAndRole } from '@/lib/auth';

export async function GET(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const blingClient = bling.forUser(session.tenant);

    const situacoes = await blingClient.getSituacoesModulo(9);

    return NextResponse.json(situacoes);
  } catch (error: unknown) {
    console.error('Erro ao buscar situações no Bling:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro ao buscar situações no Bling';
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
