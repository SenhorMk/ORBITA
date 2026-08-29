import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import {
  actorContextDenialStatus,
  resolveActorContext,
  verifySessionAndRole,
} from '@/lib/auth';
import { encrypt } from '@/lib/crypto';
import { blingCredentialsPayloadSchema } from '@/lib/config/blingCredentialsContract';

export const dynamic = 'force-dynamic';

// GET: Retorna o status atual de configuração das APIs (Bling e Chatwoot)
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

// POST: Atualiza credenciais do Bling no Supabase
export async function POST(request: Request) {
  try {
    const actorContextResult = await resolveActorContext(request, 'tenant:manage');
    if (actorContextResult._tag !== 'ActorContextResolved') {
      return NextResponse.json(
        { success: false, error: 'Não autorizado' },
        { status: actorContextDenialStatus(actorContextResult) },
      );
    }
    const session = actorContextResult.context;

    const body: unknown = await request.json();
    const parsedBody = blingCredentialsPayloadSchema.safeParse(body);

    if (!parsedBody.success) {
      // Mensagem por campo em vez do genérico anterior: um corpo com a forma
      // errada agora diz o que faltou, em vez de alegar que o usuário não
      // preencheu campos que ele de fato preencheu.
      return NextResponse.json(
        {
          success: false,
          error: 'Client ID e Client Secret são obrigatórios.',
          details: parsedBody.error.issues.map((issue) => issue.message),
        },
        { status: 400 },
      );
    }

    const { clientId, clientSecret } = parsedBody.data;

    const userId = session.tenant.id;

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
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Erro ao salvar configurações';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
