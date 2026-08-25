import { NextResponse } from 'next/server';
import { ChatwootClient } from '../../../../services/chatwoot';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { outboxService } from '../../../../services/outboxService';
import { organizationContextToScope } from '../../../../lib/verifiedOrganizationScope';
import type { VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

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
  scope: VerifiedOrganizationScope,
): Promise<boolean> {
  const query = supabaseServer
    .from('chatwoot_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('organizacao_id', scope.organizationId);

  const { data, error } = await query.maybeSingle();
  return Boolean(!error && data);
}

async function saveMessageLocally(
  rawMsg: ChatwootApiMessageResponse,
  conversationId: string | number,
  content: string,
  scope: VerifiedOrganizationScope,
): Promise<void> {
  const { error: dbError } = await supabaseServer
    .from('chatwoot_messages')
    .upsert({
      id: rawMsg.id,
      user_id: scope.actorId,
      organizacao_id: scope.organizationId,
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
    const contextResult = await resolveActiveRequestOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      );
    }

    const { conversationId, content } = await request.json();
    if (!conversationId || !content) {
      return NextResponse.json(
        { success: false, error: 'Parâmetros conversationId e content são obrigatórios.' },
        { status: 400 },
      );
    }

    const scope = organizationContextToScope(contextResult.context);

    const exists = await verifyConversationBelongsToOrg(
      conversationId,
      scope,
    );

    if (!exists) {
      return NextResponse.json({ success: false, error: 'Conversa não encontrada' }, { status: 404 });
    }

    const idempotencyKey = `chatwoot_msg_${conversationId}_${Date.now()}`;
    const outboxRecord = await outboxService.enqueue(supabaseServer, scope, {
      idempotencyKey,
      destination: 'chatwoot',
      eventType: 'message.send',
      payload: { conversationId, content },
    });

    let rawMsg: ChatwootApiMessageResponse;
    try {
      const client = await ChatwootClient.forOrganization(scope);
      rawMsg = (await client.sendMessageToApi(conversationId, content)) as ChatwootApiMessageResponse;
      await outboxService.markSent(supabaseServer, scope, outboxRecord.eventoId, {
        id: rawMsg.id,
        created_at: rawMsg.created_at,
      });
    } catch (sendErr: unknown) {
      await outboxService.markFailed(supabaseServer, scope, outboxRecord.eventoId, sendErr, 0);
      throw sendErr;
    }

    await saveMessageLocally(rawMsg, conversationId, content, scope);

    return NextResponse.json({ success: true, message: rawMsg });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao enviar mensagem';
    console.error('❌ Erro na API de envio de mensagem do Chatwoot:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
