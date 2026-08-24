import { NextResponse } from 'next/server';
import { ChatwootClient } from '../../../../services/chatwoot';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { verifySessionAndRole } from '../../../../lib/auth';
import { resolveActiveOrganization } from '../../../../lib/organizationContext';
import { outboxService } from '../../../../services/outboxService';

export const dynamic = 'force-dynamic';

function resolveMessageType(rawType: unknown): 'incoming' | 'outgoing' | 'system' | 'template' {
  if (rawType === 'incoming' || rawType === 0 || rawType === '0') return 'incoming';
  if (rawType === 'system' || rawType === 2 || rawType === '2') return 'system';
  if (rawType === 'template' || rawType === 3 || rawType === '3') return 'template';
  return 'outgoing';
}

function resolveSenderType(senderType?: string | null): string {
  if (senderType && ['contact', 'user', 'agent'].includes(senderType)) {
    return senderType;
  }
  return 'user';
}

interface ChatwootApiMessageResponse {
  id: number;
  message_type?: string | number;
  sender?: {
    name?: string;
    id?: number;
    type?: string;
  };
  created_at?: string;
}

async function verifyConversationBelongsToOrg(
  conversationId: string | number,
  orgId: string,
  userId: string,
  isOrgActive: boolean,
): Promise<boolean> {
  let query = supabaseServer
    .from('chatwoot_conversations')
    .select('id')
    .eq('id', conversationId);

  if (isOrgActive) {
    query = query.or(`organizacao_id.eq.${orgId},user_id.eq.${userId}`);
  } else {
    query = query.eq('user_id', userId);
  }

  const { data, error } = await query.maybeSingle();
  return Boolean(!error && data);
}

async function saveMessageLocally(
  rawMsg: ChatwootApiMessageResponse,
  conversationId: string | number,
  content: string,
  orgId: string,
  userId: string,
): Promise<void> {
  const { error: dbError } = await supabaseServer
    .from('chatwoot_messages')
    .upsert({
      id: rawMsg.id,
      user_id: userId,
      organizacao_id: orgId,
      conversation_id: conversationId,
      content,
      message_type: resolveMessageType(rawMsg.message_type),
      sender_name: rawMsg.sender?.name || 'Atendente Orbita',
      sender_id: rawMsg.sender?.id || null,
      sender_type: resolveSenderType(rawMsg.sender?.type),
      created_at: rawMsg.created_at || new Date().toISOString(),
    });

  if (dbError) throw dbError;

  await supabaseServer
    .from('chatwoot_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { conversationId, content } = await request.json();
    if (!conversationId || !content) {
      return NextResponse.json(
        { success: false, error: 'Parâmetros conversationId e content são obrigatórios.' },
        { status: 400 },
      );
    }

    const preferredOrgId = request.headers.get('cookie')?.match(/orbita_active_org=([^;]+)/)?.[1];
    const activeOrg = await resolveActiveOrganization(supabaseServer, session.actorId, preferredOrgId);
    const orgId = activeOrg?.organizacao.id ?? session.tenant.id;

    const exists = await verifyConversationBelongsToOrg(
      conversationId,
      orgId,
      session.tenant.id,
      Boolean(activeOrg),
    );

    if (!exists) {
      return NextResponse.json({ success: false, error: 'Conversa não encontrada' }, { status: 404 });
    }

    const idempotencyKey = `chatwoot_msg_${conversationId}_${Date.now()}`;
    const outboxRecord = await outboxService.enqueue(supabaseServer, {
      organizacaoId: orgId,
      userId: session.tenant.id,
      idempotencyKey,
      destination: 'chatwoot',
      eventType: 'message.send',
      payload: { conversationId, content },
    });

    let rawMsg: ChatwootApiMessageResponse;
    try {
      const client = await ChatwootClient.forOrganization(orgId);
      rawMsg = (await client.sendMessageToApi(conversationId, content)) as ChatwootApiMessageResponse;
      await outboxService.markSent(supabaseServer, outboxRecord.eventoId, {
        id: rawMsg.id,
        created_at: rawMsg.created_at,
      });
    } catch (sendErr: unknown) {
      await outboxService.markFailed(supabaseServer, outboxRecord.eventoId, sendErr, 0);
      throw sendErr;
    }

    await saveMessageLocally(rawMsg, conversationId, content, orgId, session.tenant.id);

    return NextResponse.json({ success: true, message: rawMsg });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao enviar mensagem';
    console.error('❌ Erro na API de envio de mensagem do Chatwoot:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
