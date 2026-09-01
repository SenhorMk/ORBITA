import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';

export async function GET(request: Request) {
  try {
    // Ticket 22 — o portão de sessão legado saiu daqui. Ele lia o papel de
    // `app_metadata`, que só os usuários históricos têm, e era redundante: o
    // escopo de organização abaixo já resolve identidade e vínculo, e já
    // distingue 401 (sem sessão), 403 (sem vínculo) e 503 (indisponível).
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const blingClient = bling.forVerifiedOrganization(scope);

    const situacoes = await blingClient.getSituacoesModulo(9);

    return NextResponse.json(situacoes);
  } catch (error: unknown) {
    console.error('Erro ao buscar situações no Bling:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro ao buscar situações no Bling';
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
