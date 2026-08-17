import { NextResponse } from 'next/server';
import { chatwootService } from '@/services/chatwoot';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifySessionAndRole } from '@/lib/auth';
import { normalizeToE164 } from '@/lib/utils';
import { integrationService } from '@/services/integrationService';

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

export async function POST(request: Request) {
  try {
    // 0. Validação de Sessão
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    console.log('🔄 Sincronização Chatwoot: Iniciando carga de dados...');
    
    // 1. Obter conversas da API do Chatwoot
    const rawConversations = await chatwootService.getConversationsFromApi();
    
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

      // Upsert contato com telefone normalizado
      const { error: contactError } = await supabaseServer
        .from('chatwoot_contacts')
        .upsert({
          id: contactId,
          name: contactName,
          email: contactEmail,
          phone_number: contactPhone,
          phone_normalizado: normalizeToE164(contactPhone),
          avatar_url: contactAvatar,
        });

      if (contactError) {
        console.error(`❌ Erro ao salvar contato ${contactId}:`, contactError);
        continue;
      }
      contactsCount++;

      // B. Processar Conversa com canal mapeado
      const conversationId = rawConv.id;
      const displayId = rawConv.display_id;
      const status = rawConv.status || 'open';
      const inboxId = rawConv.inbox_id || null;
      const channel = mapChatwootChannel(rawConv.meta?.channel || rawConv.channel_type);

      const { error: convError } = await supabaseServer
        .from('chatwoot_conversations')
        .upsert({
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

      // C. Processar Mensagens desta conversa
      const rawMessages = await chatwootService.getMessagesFromApi(conversationId);
      
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

        const { error: msgError } = await supabaseServer
          .from('chatwoot_messages')
          .upsert({
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

    console.log(`✅ Sincronização Chatwoot concluída: +${contactsCount} contatos, +${conversationsCount} conversas, +${messagesCount} mensagens.`);

    // 2. Acionar Auto-Registro e Vínculo SAC-ERP
    const linkResult = await integrationService.linkSacToErp();
    console.log('✅ Resultado do Link SAC-ERP:', linkResult);

    return NextResponse.json({
      success: true,
      stats: {
        contacts: contactsCount,
        conversations: conversationsCount,
        messages: messagesCount,
      }
    });

  } catch (error: any) {
    console.error('❌ Erro na API de sincronização do Chatwoot:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro interno na sincronização do Chatwoot' },
      { status: 500 }
    );
  }
}

// Permitir também requisição GET para testes simples via navegador
export async function GET(request: Request) {
  return POST(request);
}
