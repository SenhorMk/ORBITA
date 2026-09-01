import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

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
    // Ticket 22, critério 13 — este `catch` era inerte atrás do 401 legado, e
    // devolvia a mensagem do erro ao cliente (CWE-209). O diagnóstico fica no
    // log; a resposta é a frase pública fixa.
    registrarFalhaInterna('bling.situacoes.listar', error);
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
