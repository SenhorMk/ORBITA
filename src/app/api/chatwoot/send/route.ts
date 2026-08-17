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

    const { conversationId, content } = await request.json();

    if (!conversationId || !content) {
      return NextResponse.json(
        { success: false, error: 'Parâmetros conversationId e content são obrigatórios.' },
        { status: 400 }
      );
    }

    console.log(`📤 Enviando mensagem para conversa ${conversationId} no Chatwoot...`);
    
    // 1. Enviar mensagem via API do Chatwoot
    const rawMsg = await chatwootService.sendMessageToApi(conversationId, content);

    // 2. Extrair dados da mensagem criada
    let msgType: 'incoming' | 'outgoing' | 'system' | 'template' = 'outgoing';
    const rawType = rawMsg.message_type;
    
    if (rawType === 'incoming' || rawType === 0 || rawType === '0') {
      msgType = 'incoming';
    } else if (rawType === 'system' || rawType === 2 || rawType === '2') {
      msgType = 'system';
    } else if (rawType === 'template' || rawType === 3 || rawType === '3') {
      msgType = 'template';
    }

    const senderName = rawMsg.sender?.name || 'Atendente Orbita';
    const senderId = rawMsg.sender?.id || null;
    let senderType = rawMsg.sender?.type || 'user';

    // Validação contra constraint CHECK de sender_type
    if (senderType && !['contact', 'user', 'agent'].includes(senderType)) {
      senderType = 'user';
    }

    const createdAt = rawMsg.created_at || new Date().toISOString();

    // 3. Salvar mensagem no Supabase local
    const { error: dbError } = await supabaseServer
      .from('chatwoot_messages')
      .upsert({
        id: rawMsg.id,
        conversation_id: conversationId,
        content: content,
        message_type: msgType,
        sender_name: senderName,
        sender_id: senderId,
        sender_type: senderType,
        created_at: createdAt,
      });

    if (dbError) {
      console.error('❌ Erro ao salvar mensagem enviada no banco:', dbError);
      throw dbError;
    }

    // 4. Atualizar o timestamp de atualização da conversa local
    const { error: convUpdateError } = await supabaseServer
      .from('chatwoot_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    if (convUpdateError) {
      console.error('❌ Erro ao atualizar timestamp da conversa:', convUpdateError);
    }

    return NextResponse.json({ success: true, message: rawMsg });

  } catch (error: any) {
    console.error('❌ Erro na API de envio de mensagem do Chatwoot:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro ao enviar mensagem' },
      { status: 500 }
    );
  }
}
