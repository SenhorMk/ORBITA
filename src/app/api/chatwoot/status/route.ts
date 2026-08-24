import { NextResponse } from 'next/server';
import { ChatwootClient } from '../../../../services/chatwoot';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { verifySessionAndRole } from '../../../../lib/auth';
import { resolveActiveOrganization } from '../../../../lib/organizationContext';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // 0. Validação de Sessão
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { conversationId, status } = await request.json();

    if (!conversationId || !status) {
      return NextResponse.json(
        { success: false, error: 'Parâmetros conversationId e status são obrigatórios.' },
        { status: 400 }
      );
    }

    const preferredOrgId = request.headers.get('cookie')?.match(/orbita_active_org=([^;]+)/)?.[1];
    const activeOrg = await resolveActiveOrganization(supabaseServer, session.actorId, preferredOrgId);
    const orgId = activeOrg?.organizacao.id ?? session.tenant.id;

    // 1. Verificar se a conversa pertence ao tenant/organização autenticado antes de alterar na API externa
    let convCheckQuery = supabaseServer
      .from('chatwoot_conversations')
      .select('id')
      .eq('id', conversationId);

    if (activeOrg) {
      convCheckQuery = convCheckQuery.or(`organizacao_id.eq.${orgId},user_id.eq.${session.tenant.id}`);
    } else {
      convCheckQuery = convCheckQuery.eq('user_id', session.tenant.id);
    }

    const { data: existingConv, error: convCheckError } = await convCheckQuery.maybeSingle();

    if (convCheckError || !existingConv) {
      return NextResponse.json(
        { success: false, error: 'Conversa não encontrada' },
        { status: 404 }
      );
    }

    // 2. Alterar status via API do Chatwoot usando client da organização
    const client = await ChatwootClient.forOrganization(orgId);
    await client.toggleStatusInApi(conversationId, status);

    // 3. Atualizar no Supabase com escopo estrito do tenant/organizacao
    const { error: dbError } = await supabaseServer
      .from('chatwoot_conversations')
      .update({ status: status, updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    if (dbError) {
      console.error('❌ Erro ao salvar status da conversa no banco:', dbError);
      throw dbError;
    }

    return NextResponse.json({ success: true });

  } catch (error: unknown) {
    console.error('❌ Erro na API de alteração de status do Chatwoot:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro ao alterar status da conversa';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
