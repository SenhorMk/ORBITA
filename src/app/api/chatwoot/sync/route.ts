import { NextResponse } from 'next/server';
import { ChatwootClient } from '../../../../services/chatwoot';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { normalizeToE164 } from '../../../../lib/utils';
import { integrationService } from '../../../../services/integrationService';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export const dynamic = 'force-dynamic';

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

interface RawSender {
  id: number;
  name?: string;
  email?: string;
  phone_number?: string;
  avatar_url?: string;
  thumbnail?: string;
  type?: string;
}

interface RawConversation {
  id: number;
  display_id: number;
  status?: string;
  inbox_id?: number;
  channel_type?: string;
  meta?: {
    sender?: RawSender;
    channel?: string;
  };
}

interface RawMessage {
  id: number;
  content?: string;
  message_type?: string | number;
  sender?: RawSender;
  created_at?: string;
}

type ChatwootPersistenceTable = 'chatwoot_contacts' | 'chatwoot_conversations' | 'chatwoot_messages';

async function upsertChatwootRecord(
  scope: VerifiedOrganizationScope,
  table: ChatwootPersistenceTable,
  record: Readonly<Record<string, unknown>>,
) {
  return supabaseServer.from(table).upsert({
    ...record,
    user_id: scope.actorId,
    organizacao_id: scope.organizationId,
  });
}

export async function POST(request: Request) {
  try {
    // 0. Validação de Sessão
    const contextResult = await resolveActiveRequestOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      );
    }

    const scope = organizationContextToScope(contextResult.context);

    // 1. Obter conversas da API do Chatwoot usando client da organização
    const client = await ChatwootClient.forOrganization(scope);
    const rawConversations = (await client.getConversationsFromApi()) as RawConversation[];

    let contactsCount = 0;
    let conversationsCount = 0;
    let messagesCount = 0;

    for (const rawConv of rawConversations) {
      // A. Processar Contato
      const sender = rawConv.meta?.sender;
      if (!sender) continue;

      const contactId = sender.id;
      const contactName = sender.name || 'Cliente Sem Nome';
      const contactEmail = sender.email || null;
      const contactPhone = sender.phone_number || null;
      const contactAvatar = sender.avatar_url || sender.thumbnail || null;

      // Upsert contato com telefone normalizado e escopo do tenant/organizacao
      const { error: contactError } = await upsertChatwootRecord(scope, 'chatwoot_contacts', {
          id: contactId,
          name: contactName,
          email: contactEmail,
          phone_number: contactPhone,
          phone_normalizado: normalizeToE164(contactPhone || undefined),
          avatar_url: contactAvatar,
      });

      if (contactError) {
        console.error(`❌ Erro ao salvar contato ${contactId}:`, contactError);
        continue;
      }
      contactsCount++;

      // B. Processar Conversa com canal mapeado e escopo do tenant/organizacao
      const conversationId = rawConv.id;
      const displayId = rawConv.display_id;
      const status = rawConv.status || 'open';
      const inboxId = rawConv.inbox_id || null;
      const channel = mapChatwootChannel(rawConv.meta?.channel || rawConv.channel_type);

      const { error: convError } = await upsertChatwootRecord(scope, 'chatwoot_conversations', {
          id: conversationId,
          display_id: displayId,
          contact_id: contactId,
          status: status,
          inbox_id: inboxId,
          channel: channel,
          updated_at: new Date().toISOString(),
      });

      if (convError) {
        console.error(`❌ Erro ao salvar conversa ${conversationId}:`, convError);
        continue;
      }
      conversationsCount++;

      // C. Processar Mensagens desta conversa com escopo do tenant/organizacao
      const rawMessages = (await client.getMessagesFromApi(conversationId)) as RawMessage[];

      for (const rawMsg of rawMessages) {
        let msgType: 'incoming' | 'outgoing' | 'system' | 'template' = 'incoming';

        const rawType = rawMsg.message_type;
        if (rawType === 1 || rawType === 'outgoing' || rawType === '1') {
          msgType = 'outgoing';
        } else if (rawType === 2 || rawType === 'system' || rawType === '2') {
          msgType = 'system';
        } else if (rawType === 3 || rawType === 'template' || rawType === '3') {
          msgType = 'template';
        }

        const senderName = rawMsg.sender?.name || null;
        const senderId = rawMsg.sender?.id || null;
        let senderType = rawMsg.sender?.type || null;

        // Validação de sender_type contra enums
        if (senderType && !['contact', 'user', 'agent'].includes(senderType)) {
          senderType = null;
        }

        const { error: msgError } = await upsertChatwootRecord(scope, 'chatwoot_messages', {
            id: rawMsg.id,
            conversation_id: conversationId,
            content: rawMsg.content || '',
            message_type: msgType,
            sender_name: senderName,
            sender_id: senderId,
            sender_type: senderType,
            created_at: rawMsg.created_at || new Date().toISOString(),
        });

        if (msgError) {
          console.error(`❌ Erro ao salvar mensagem ${rawMsg.id}:`, msgError);
          continue;
        }
        messagesCount++;
      }
    }

    // 2. Acionar Auto-Registro e Vínculo SAC-ERP
    await integrationService.linkSacToErp(scope);

    return NextResponse.json({
      success: true,
      stats: {
        contacts: contactsCount,
        conversations: conversationsCount,
        messages: messagesCount,
      }
    });

  } catch (error: unknown) {
    console.error('❌ Erro na API de sincronização do Chatwoot:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro interno na sincronização do Chatwoot';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}

// Permitir também requisição GET para testes simples via navegador
export async function GET(request: Request) {
  return POST(request);
}
