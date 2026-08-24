import { NextResponse } from 'next/server';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { verifySessionAndRole } from '../../../../lib/auth';
import { createOAuthTransaction } from '../../../../lib/oauth-transaction';
import { resolveActiveOrganization } from '../../../../lib/organizationContext';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await verifySessionAndRole(request);

  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Sessão inválida ou expirada.' },
      { status: 401 },
    );
  }

  const userId = session.tenant.id;
  const activeOrg = await resolveActiveOrganization(supabaseServer, userId);
  const organizacaoId = activeOrg?.organizacao.id;

  let clientId: string | null = null;

  if (organizacaoId) {
    const { data: connData } = await supabaseServer
      .from('conexoes_integracao')
      .select('metadata')
      .eq('organizacao_id', organizacaoId)
      .eq('provedor', 'bling')
      .maybeSingle();

    const meta = connData?.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.client_id === 'string' && meta.client_id.length > 0) {
      clientId = meta.client_id;
    }
  }

  if (!clientId) {
    const { data: tenantData } = await supabaseServer
      .from('integracoes_bling')
      .select('client_id')
      .eq('user_id', userId)
      .maybeSingle();

    clientId = tenantData?.client_id || null;
  }

  if (!clientId) {
    return NextResponse.json(
      { success: false, error: 'Nenhum Client ID configurado para esta conta.' },
      { status: 409 },
    );
  }

  const transaction = createOAuthTransaction(userId, organizacaoId);
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
