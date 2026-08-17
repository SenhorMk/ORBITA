import { NextResponse } from 'next/server';
import { chatwootService } from '@/services/chatwoot';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifySessionAndRole } from '@/lib/auth';

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

    console.log(`🔄 Alterando status da conversa ${conversationId} para "${status}"...`);
    
    // 1. Alterar status via API do Chatwoot
    await chatwootService.toggleConversationStatus(conversationId, status);

    // 2. Atualizar no Supabase local
    const { error: dbError } = await supabaseServer
      .from('chatwoot_conversations')
      .update({ status: status, updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    if (dbError) {
      console.error('❌ Erro ao salvar status da conversa no banco:', dbError);
      throw dbError;
    }

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('❌ Erro na API de alteração de status do Chatwoot:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro ao alterar status da conversa' },
      { status: 500 }
    );
  }
}
