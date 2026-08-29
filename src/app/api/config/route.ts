import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifySessionAndRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Status legado de configuração das APIs (Bling e Chatwoot) por usuário.
 *
 * O handler `POST` que gravava credenciais do Bling em `integracoes_bling` foi
 * removido no Ticket 28: aquela tabela perdeu os grants de `service_role` nas
 * migrations de endurecimento, então toda escrita falhava. O caminho vivo de
 * registro de credenciais é `POST /api/bling/connect`, que persiste em
 * `conexoes_integracao` + cofre cifrado por organização.
 */
export async function GET(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const userId = session.tenant.id;

    const { data: blingConfig } = await supabaseServer
      .from('integracoes_bling')
      .select('client_id, client_secret, access_token, token_expires_at')
      .eq('user_id', userId)
      .maybeSingle();

    const realClientId = blingConfig?.client_id || (process.env.BLING_CLIENT_ID !== 'sua_chave_de_api_bling_aqui' ? process.env.BLING_CLIENT_ID : '');
    const realClientSecret = blingConfig?.client_secret || (process.env.BLING_CLIENT_SECRET !== 'sua_chave_de_api_bling_aqui' ? process.env.BLING_CLIENT_SECRET : '');

    const isBlingConnected = Boolean(
      blingConfig?.access_token &&
      blingConfig.access_token !== 'access_token_placeholder'
    );

    return NextResponse.json({
      success: true,
      config: {
        bling: {
          clientId: realClientId || '',
          hasClientSecret: Boolean(realClientSecret),
          isConnected: isBlingConnected,
          expiresAt: blingConfig?.token_expires_at || null,
        },
        chatwoot: {
          apiUrl: process.env.CHATWOOT_API_URL || 'https://app.chatwoot.com',
          accountId: process.env.CHATWOOT_ACCOUNT_ID || '',
          hasToken: Boolean(process.env.CHATWOOT_API_TOKEN && process.env.CHATWOOT_API_TOKEN !== 'sua_chave_de_api_chatwoot_aqui'),
        }
      }
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Erro ao carregar configurações';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
