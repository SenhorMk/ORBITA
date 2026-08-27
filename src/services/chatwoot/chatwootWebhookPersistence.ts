import { supabaseServer } from '@/lib/supabaseServer';
import { normalizeToE164 } from '@/lib/utils';
import type { ChatwootWebhookEvent } from '@/services/chatwoot/chatwootPort';

export interface PersistedWebhookEffects {
  readonly contactId: number | null;
  readonly conversationId: number | null;
  readonly messageId: number | null;
}

function mapChatwootChannel(channelStr?: string): string {
  if (!channelStr) return 'Channel::Whatsapp';
  const upper = channelStr.toUpperCase();
  if (upper.includes('WHATSAPP')) return 'Channel::Whatsapp';
  if (upper.includes('WEBWIDGET') || upper.includes('WEB_WIDGET') || upper.includes('WEB')) return 'Channel::WebWidget';
  if (upper.includes('API')) return 'Channel::Api';
  if (upper.includes('EMAIL')) return 'Channel::Email';
  if (upper.includes('TELEGRAM')) return 'Channel::Telegram';
  if (upper.includes('SMS')) return 'Channel::Sms';
  if (upper.includes('TWITTER')) return 'Channel::TwitterProfile';
  if (upper.includes('FACEBOOK')) return 'Channel::FacebookPage';
  return 'Channel::Whatsapp';
}

/** Parse a Chatwoot numeric identifier that may arrive as a JSON number or a
 * numeric string, rejecting anything else (never `NaN`/`Infinity` downstream). */
export function parseOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Apply the contact/conversation upserts for one verified webhook event.
 * Every write carries `organizacao_id`/`conexao_id` from the already-verified scope. */
async function persistWebhookContactAndConversation(
  payload: ChatwootWebhookEvent,
  organizacaoId: string,
  conexaoId: string,
  userId: string,
  inboxId: number | null,
): Promise<{ contactId: number | null; conversationId: number | null }> {
  const conversationData = payload.conversation;
  let rawContactId: number | string | undefined = payload.meta?.sender?.id;
  let contactName = payload.meta?.sender?.name;
  let contactEmail = payload.meta?.sender?.email ?? undefined;
  let contactPhone = payload.meta?.sender?.phone_number ?? undefined;
  let contactAvatar = payload.meta?.sender?.avatar_url ?? payload.meta?.sender?.thumbnail ?? undefined;

  if (conversationData?.contact) {
    if (!rawContactId) rawContactId = conversationData.contact.id;
    if (!contactName) contactName = conversationData.contact.name;
    if (!contactEmail) contactEmail = conversationData.contact.email ?? undefined;
    if (!contactPhone) contactPhone = conversationData.contact.phone_number ?? undefined;
    if (!contactAvatar) contactAvatar = conversationData.contact.avatar_url ?? undefined;
  }

  const contactId = parseOptionalInt(rawContactId);

  if (contactId !== null) {
    const { error: contactError } = await supabaseServer
      .from('chatwoot_contacts')
      .upsert({
        id: contactId,
        user_id: userId,
        organizacao_id: organizacaoId,
        conexao_id: conexaoId,
        name: contactName || 'Cliente WhatsApp',
        email: contactEmail || null,
        phone_number: contactPhone || null,
        phone_normalizado: normalizeToE164(contactPhone),
        avatar_url: contactAvatar || null,
        updated_at: new Date().toISOString(),
      });
    if (contactError) throw contactError;
  }

  let conversationId: number | null = null;
  if (conversationData?.id) {
    const convId = parseOptionalInt(conversationData.id);
    const convContactId = contactId ?? parseOptionalInt(conversationData.contact_id ?? conversationData.contact?.id);

    if (convId !== null && convContactId !== null) {
      conversationId = convId;
      const channel = mapChatwootChannel(payload.meta?.channel || conversationData.channel);
      const displayId = parseOptionalInt(conversationData.display_id);
      const convInboxId = parseOptionalInt(conversationData.inbox_id) ?? inboxId;

      const { error: convError } = await supabaseServer
        .from('chatwoot_conversations')
        .upsert({
          id: convId,
          user_id: userId,
          organizacao_id: organizacaoId,
          conexao_id: conexaoId,
          display_id: displayId,
          contact_id: convContactId,
          status: conversationData.status || 'open',
          inbox_id: convInboxId,
          channel,
          updated_at: new Date().toISOString(),
        });
      if (convError) throw convError;
    }
  }

  return { contactId, conversationId };
}

/** Apply the message upsert for a `message_created`/`message_updated` event. */
async function persistWebhookMessage(
  payload: ChatwootWebhookEvent,
  organizacaoId: string,
  conexaoId: string,
  userId: string,
): Promise<number | null> {
  const msgId = parseOptionalInt(payload.id);
  const conversationId = parseOptionalInt(payload.conversation?.id || payload.conversation_id);
  const content = payload.content || '';

  let msgType: 'incoming' | 'outgoing' | 'system' | 'template' = 'incoming';
  const rawType = payload.message_type;
  if (rawType === 'outgoing' || rawType === 1 || rawType === '1') msgType = 'outgoing';
  else if (rawType === 'system' || rawType === 2 || rawType === '2') msgType = 'system';
  else if (rawType === 'template' || rawType === 3 || rawType === '3') msgType = 'template';

  const senderName = payload.sender?.name || null;
  const senderId = parseOptionalInt(payload.sender?.id);
  let senderType = payload.sender?.type || null;
  if (senderType && !['contact', 'user', 'agent'].includes(senderType)) senderType = null;
  const createdAt = payload.created_at || new Date().toISOString();

  if (conversationId === null || msgId === null) return null;

  const { error: msgError } = await supabaseServer
    .from('chatwoot_messages')
    .upsert({
      id: msgId,
      user_id: userId,
      organizacao_id: organizacaoId,
      conexao_id: conexaoId,
      conversation_id: conversationId,
      content,
      message_type: msgType,
      sender_name: senderName,
      sender_id: senderId,
      sender_type: senderType,
      created_at: createdAt,
      updated_at: new Date().toISOString(),
    });
  if (msgError) throw msgError;
  return msgId;
}

/** Apply every side effect for one verified, non-duplicate webhook event. */
export async function persistWebhookEffects(
  payload: ChatwootWebhookEvent,
  organizacaoId: string,
  conexaoId: string,
  userId: string,
  inboxId: number | null,
): Promise<PersistedWebhookEffects> {
  const { contactId, conversationId } = await persistWebhookContactAndConversation(
    payload,
    organizacaoId,
    conexaoId,
    userId,
    inboxId,
  );

  let messageId: number | null = null;
  if (payload.event === 'message_created' || payload.event === 'message_updated') {
    messageId = await persistWebhookMessage(payload, organizacaoId, conexaoId, userId);
  }

  return { contactId, conversationId, messageId };
}

/** Update just a conversation's status for a `conversation_status_changed` event. */
export async function persistConversationStatusChange(
  organizacaoId: string,
  convId: number,
  status: string,
): Promise<void> {
  const { error } = await supabaseServer
    .from('chatwoot_conversations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', convId)
    .eq('organizacao_id', organizacaoId);
  if (error) throw error;
}
