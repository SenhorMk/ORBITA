import { NextResponse } from 'next/server';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { createScopedOAuthTransaction } from '../../../../lib/oauth-transaction';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export const dynamic = 'force-dynamic';

async function findBlingClientId(scope: VerifiedOrganizationScope): Promise<string | null> {
  const { data } = await supabaseServer
    .from('conexoes_integracao')
    .select('metadata')
    .eq('organizacao_id', scope.organizationId)
    .eq('provedor', 'bling')
    .maybeSingle();
  // SAFETY: PostgREST JSON is narrowed to an object and client_id is validated before use.
  const parsed = typeof data?.metadata === 'object' && data.metadata !== null
    ? data.metadata as Record<string, unknown>
    : null;
  return typeof parsed?.client_id === 'string' && parsed.client_id.length > 0
    ? parsed.client_id
    : null;
}

export async function GET(request: Request) {
  const contextResult = await resolveActiveRequestOrganizationContext(request);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return NextResponse.json(
      { success: false, error: status === 503 ? 'Serviço de autorização indisponível.' : 'Sessão inválida ou expirada.' },
      { status },
    );
  }

  const scope = organizationContextToScope(contextResult.context);
  const clientId = await findBlingClientId(scope);

  if (!clientId) {
    return NextResponse.json(
      { success: false, error: 'Nenhum Client ID configurado para esta conta.' },
      { status: 409 },
    );
  }

  const transaction = createScopedOAuthTransaction(scope);
  if (transaction._tag === 'OAuthTransactionCreationFailed') {
    console.error('[authorize] Configuração de criptografia indisponível.');
    return NextResponse.json(
      { success: false, error: 'Configuração segura do servidor incompleta.' },
      { status: 503 },
    );
  }

  const authorizeUrl =
    `https://www.bling.com.br/Api/v3/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&state=${encodeURIComponent(transaction.state)}`;

  console.info('[authorize] URL de autorização do Bling emitida.');

  const response = NextResponse.json({ success: true, authorizeUrl });
  response.cookies.set('orbita_oauth_transaction', transaction.cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/api/bling/callback',
  });

  return response;
}
