import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifySessionAndRole } from '@/lib/auth';
import { encrypt } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

// GET: Retorna o status atual de configuração das APIs (Bling e Chatwoot)
export async function GET(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    let userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'User ID não encontrado na sessão' }, { status: 401 });
    }

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
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Erro ao carregar configurações' },
      { status: 500 }
    );
  }
}

// POST: Atualiza credenciais do Bling no Supabase
export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (session.role !== 'dono') {
      return NextResponse.json({ success: false, error: 'Acesso negado: Apenas o dono pode alterar configurações' }, { status: 403 });
    }

    const body = await request.json();
    const { clientId, clientSecret } = body;

    if (!clientId || !clientSecret) {
      return NextResponse.json({ success: false, error: 'Client ID e Client Secret são obrigatórios.' }, { status: 400 });
    }

    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'User ID não encontrado na sessão' }, { status: 401 });
    }
    
    const { data: existing } = await supabaseServer
      .from('integracoes_bling')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    let error;
    if (existing?.id) {
      const res = await supabaseServer
        .from('integracoes_bling')
        .update({
          client_id: clientId,
          client_secret: encrypt(clientSecret)
        })
        .eq('id', existing.id);
      error = res.error;
    } else {
      const res = await supabaseServer
        .from('integracoes_bling')
        .insert({
          user_id: userId,
          client_id: clientId,
          client_secret: encrypt(clientSecret)
        });
      error = res.error;
    }

    if (error) {
      throw new Error(`Erro ao salvar no banco de dados: ${error.message}`);
    }

    return NextResponse.json({
      success: true,
      message: 'Configurações do Bling salvas com sucesso!'
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Erro ao salvar configurações' },
      { status: 500 }
    );
  }
}
