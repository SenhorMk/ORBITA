import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { normalizeToE164 } from '@/lib/utils';
import crypto from 'crypto';

// Força a rota a ser dinâmica (Next.js App Router)
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
    const rawBody = await request.text();
    const signature = request.headers.get('x-chatwoot-signature');
    const webhookSecret = process.env.CHATWOOT_WEBHOOK_SECRET;

    // 0. Validação de Assinatura HMAC OBRIGATÓRIA
    if (!webhookSecret || webhookSecret === 'sua_assinatura_webhook_chatwoot_aqui') {
      console.error('❌ Webhook Chatwoot: Segredo HMAC não configurado no servidor (CHATWOOT_WEBHOOK_SECRET).');
      return NextResponse.json({ success: false, error: 'Configuração inválida no servidor' }, { status: 500 });
    }

    if (!signature) {
      return NextResponse.json({ success: false, error: 'Assinatura ausente' }, { status: 401 });
    }

    const expectedHex = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedHex);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      console.error('❌ Webhook Chatwoot: Assinatura inválida.');
      return NextResponse.json({ success: false, error: 'Assinatura inválida' }, { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;

    console.log(`🔔 Webhook Chatwoot recebido. Evento: ${event}`);

    if (!event) {
      return NextResponse.json({ success: false, error: 'Evento não especificado' }, { status: 400 });
    }

    // 0.5. Resolver Tenant (userId) via inbox_id ou query param
    const inboxId = payload.inbox?.id || payload.conversation?.inbox_id;
    let userId = null;
    
    if (inboxId) {
      const { data: inbox } = await supabaseServer.from('chatwoot_inboxes').select('user_id').eq('inbox_id', inboxId).maybeSingle();
      if (inbox?.user_id) userId = inbox.user_id;
    }

    if (!userId) {
      const url = new URL(request.url);
      userId = url.searchParams.get('userId');
    }

    if (!userId) {
       console.warn('⚠️ Webhook Chatwoot: Não foi possível determinar o tenant (userId) a partir do inbox ou da query string.');
       return NextResponse.json({ success: false, error: 'Tenant não identificado' }, { status: 400 });
    }

    // 1. Processar Contato e Conversa associados ao evento
    let contactId = payload.meta?.sender?.id;
    let contactName = payload.meta?.sender?.name;
    let contactEmail = payload.meta?.sender?.email;
    let contactPhone = payload.meta?.sender?.phone_number;
    let contactAvatar = payload.meta?.sender?.avatar_url || payload.meta?.sender?.thumbnail;

    // Se não encontrou no meta, tenta na própria estrutura de conversation
    const conversationData = payload.conversation;
    if (conversationData?.contact) {
      if (!contactId) contactId = conversationData.contact.id;
      if (!contactName) contactName = conversationData.contact.name;
      if (!contactEmail) contactEmail = conversationData.contact.email;
      if (!contactPhone) contactPhone = conversationData.contact.phone_number;
      if (!contactAvatar) contactAvatar = conversationData.contact.avatar_url;
    }

    // Se temos um contato básico, fazer upsert com telefone normalizado
    if (contactId) {
      const { error: contactError } = await supabaseServer
        .from('chatwoot_contacts')
        .upsert({
          id: contactId,
          user_id: userId,
          name: contactName || 'Cliente WhatsApp',
          email: contactEmail || null,
          phone_number: contactPhone || null,
          phone_normalizado: normalizeToE164(contactPhone),
          avatar_url: contactAvatar || null,
        });

      if (contactError) {
        console.error('❌ Webhook: Erro ao salvar contato:', contactError);
        throw contactError;
      }
    }

    // Se temos uma conversa básica, fazer upsert
    if (conversationData) {
      const channel = mapChatwootChannel(payload.meta?.channel || conversationData.channel);
      const { error: convError } = await supabaseServer
        .from('chatwoot_conversations')
        .upsert({
          id: conversationData.id,
          user_id: userId,
          display_id: conversationData.display_id,
          contact_id: contactId || conversationData.contact?.id,
          status: conversationData.status || 'open',
          inbox_id: conversationData.inbox_id || null,
          channel: channel,
          updated_at: new Date().toISOString(),
        });

      if (convError) {
        console.error('❌ Webhook: Erro ao salvar conversa:', convError);
        throw convError;
      }
    }

    // 2. Processar a Mensagem (caso o evento seja de criação/atualização de mensagem)
    if (event === 'message_created' || event === 'message_updated') {
      const msgId = payload.id;
      const conversationId = conversationData?.id || payload.conversation_id;
      const content = payload.content || '';
      
      let msgType: 'incoming' | 'outgoing' | 'system' | 'template' = 'incoming';
      const rawType = payload.message_type;
      
      if (rawType === 'outgoing' || rawType === 1 || rawType === '1') {
        msgType = 'outgoing';
      } else if (rawType === 'system' || rawType === 2 || rawType === '2') {
        msgType = 'system';
      } else if (rawType === 'template' || rawType === 'activity' || rawType === 3 || rawType === '3') {
        msgType = 'template';
      }

      const senderName = payload.sender?.name || null;
      const senderId = payload.sender?.id || null;
      let senderType = payload.sender?.type || null;

      // Validação de domínio do sender_type contra constraint CHECK
      if (senderType && !['contact', 'user', 'agent'].includes(senderType)) {
        senderType = null;
      }

      const createdAt = payload.created_at || new Date().toISOString();

      if (conversationId && msgId) {
        const { error: msgError } = await supabaseServer
          .from('chatwoot_messages')
          .upsert({
            id: msgId,
            user_id: userId,
            conversation_id: conversationId,
            content: content,
            message_type: msgType,
            sender_name: senderName,
            sender_id: senderId,
            sender_type: senderType,
            created_at: createdAt,
          });

        if (msgError) {
          console.error('❌ Webhook: Erro ao salvar mensagem:', msgError);
          throw msgError;
        } else {
          console.log(`✅ Webhook: Mensagem ${msgId} salva com sucesso no Supabase.`);
        }
      }
    }

    // Se o status da conversa mudou no Chatwoot (ex: resolvido)
    if (event === 'conversation_status_changed' && conversationData) {
      const { error: statusError } = await supabaseServer
        .from('chatwoot_conversations')
        .update({ status: conversationData.status })
        .eq('id', conversationData.id)
        .eq('user_id', userId);

      if (statusError) {
        console.error('❌ Webhook: Erro ao atualizar status da conversa:', statusError);
        throw statusError;
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('❌ Erro de processamento no Webhook do Chatwoot:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro interno no processamento do webhook' },
      { status: 500 }
    );
  }
}

