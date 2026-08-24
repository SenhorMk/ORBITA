import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { normalizeToE164 } from '../../../../lib/utils';
import { chatwootInboxService, generateChatwootIdempotencyKey } from '../../../../services/chatwootInboxService';
import { verifyOrganizationScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

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

function parseOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

interface ChatwootContactPayload {
  readonly id?: number | string;
  readonly name?: string;
  readonly email?: string;
  readonly phone_number?: string;
  readonly avatar_url?: string;
  readonly thumbnail?: string;
}

interface ChatwootConversationPayload {
  readonly id?: number | string;
  readonly display_id?: number | string;
  readonly contact_id?: number | string;
  readonly status?: string;
  readonly inbox_id?: number | string;
  readonly channel?: string;
  readonly contact?: ChatwootContactPayload;
}

interface ChatwootWebhookEvent {
  readonly event?: string;
  readonly id?: number | string;
  readonly content?: string;
  readonly message_type?: string | number;
  readonly conversation_id?: number | string;
  readonly created_at?: string;
  readonly inbox?: { readonly id?: number | string };
  readonly conversation?: ChatwootConversationPayload;
  readonly sender?: {
    readonly id?: number | string;
    readonly name?: string;
    readonly type?: string;
  };
  readonly meta?: {
    readonly sender?: ChatwootContactPayload;
    readonly channel?: string;
  };
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook do Chatwoot ativo e pronto para receber notificações de contatos, conversas e mensagens.',
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  let inboxEventoId: string | null = null;
  let organizationScope: VerifiedOrganizationScope | null = null;

  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-chatwoot-signature');
    const webhookSecret = process.env.CHATWOOT_WEBHOOK_SECRET;

    // 0. Validação de Assinatura HMAC OBRIGATÓRIA (fail-closed)
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

    let payload: ChatwootWebhookEvent;
    try {
      payload = JSON.parse(rawBody) as ChatwootWebhookEvent;
    } catch {
      return NextResponse.json({ success: false, error: 'Payload JSON inválido' }, { status: 400 });
    }

    const event = payload.event;
    if (!event) {
      return NextResponse.json({ success: false, error: 'Evento não especificado' }, { status: 400 });
    }

    // 0.5. Resolver Tenant exclusivamente via mapeamento confiável de inbox_id no banco
    const rawInboxId = payload.inbox?.id || payload.conversation?.inbox_id;
    const inboxId = parseOptionalInt(rawInboxId);
    let userId: string | null = null;
    let organizacaoId: string | null = null;
    let conexaoId: string | null = null;

    if (inboxId !== null) {
      const { data: inbox } = await supabaseServer
        .from('chatwoot_inboxes')
        .select('user_id, organizacao_id, conexao_id')
        .eq('inbox_id', inboxId)
        .maybeSingle();

      if (inbox?.user_id) {
        userId = inbox.user_id;
      }
      if (inbox?.organizacao_id) {
        organizacaoId = inbox.organizacao_id;
      }
      if (inbox?.conexao_id) {
        conexaoId = inbox.conexao_id;
      }
    }

    if (!userId) {
      console.warn('⚠️ Webhook Chatwoot: Caixa de entrada (inbox) não registrada para nenhum tenant.');
      return NextResponse.json({ success: false, error: 'Tenant não identificado' }, { status: 400 });
    }

    // Se organizacaoId não estiver explícita no inbox, resolver via membros_organizacao
    if (!organizacaoId) {
      const { data: membro } = await supabaseServer
        .from('membros_organizacao')
        .select('organizacao_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (membro?.organizacao_id) {
        organizacaoId = membro.organizacao_id;
      }
    }

    if (!organizacaoId) {
      organizacaoId = userId;
    }

    const scopeResult = await verifyOrganizationScope(supabaseServer, {
      organizationId: organizacaoId,
      actorId: userId,
    });
    if (scopeResult._tag !== 'OrganizationScopeVerified') {
      const unavailable = scopeResult._tag === 'OrganizationScopeStoreUnavailable';
      return NextResponse.json(
        { success: false, error: unavailable ? 'Serviço de autorização indisponível' : 'Escopo organizacional inválido' },
        { status: unavailable ? 503 : 403 },
      );
    }
    organizationScope = scopeResult.scope;

    const idempotencyKey = generateChatwootIdempotencyKey(payload);

    // 1. Registro prévio no inbox idempotente
    const inboxResult = await chatwootInboxService.registerEvent(supabaseServer, organizationScope, {
      conexaoId,
      inboxId: inboxId ?? undefined,
      idempotencyKey,
      eventType: event,
      payload,
    });

    inboxEventoId = inboxResult.eventoId;

    // 2. Duplicata segura: se já processado com sucesso, retornar resultado cacheado sem repetir efeitos
    if (inboxResult.isDuplicate && inboxResult.status === 'processed') {
      return NextResponse.json(inboxResult.cachedResponse || { success: true });
    }

    // 3. Processar Contato e Conversa associados ao evento
    const conversationData = payload.conversation;
    let rawContactId = payload.meta?.sender?.id;
    let contactName = payload.meta?.sender?.name;
    let contactEmail = payload.meta?.sender?.email;
    let contactPhone = payload.meta?.sender?.phone_number;
    let contactAvatar = payload.meta?.sender?.avatar_url || payload.meta?.sender?.thumbnail;

    if (conversationData?.contact) {
      if (!rawContactId) rawContactId = conversationData.contact.id;
      if (!contactName) contactName = conversationData.contact.name;
      if (!contactEmail) contactEmail = conversationData.contact.email;
      if (!contactPhone) contactPhone = conversationData.contact.phone_number;
      if (!contactAvatar) contactAvatar = conversationData.contact.avatar_url;
    }

    const contactId = parseOptionalInt(rawContactId);

    // Se temos um contato com ID válido, fazer upsert idempotente
    if (contactId !== null) {
      const { error: contactError } = await supabaseServer
        .from('chatwoot_contacts')
        .upsert({
          id: contactId,
          user_id: userId,
          organizacao_id: organizacaoId,
          conexao_id: conexaoId || undefined,
          name: contactName || 'Cliente WhatsApp',
          email: contactEmail || null,
          phone_number: contactPhone || null,
          phone_normalizado: normalizeToE164(contactPhone),
          avatar_url: contactAvatar || null,
          updated_at: new Date().toISOString(),
        });

      if (contactError) {
        console.error('❌ Webhook: Erro ao salvar contato:', contactError);
        throw contactError;
      }
    }

    // Se o evento é apenas de alteração de status da conversa existente
    if (event === 'conversation_status_changed' && conversationData?.id) {
      const convId = parseOptionalInt(conversationData.id);
      if (convId !== null) {
        const { error: statusError } = await supabaseServer
          .from('chatwoot_conversations')
          .update({
            status: conversationData.status || 'open',
            updated_at: new Date().toISOString(),
          })
          .eq('id', convId);

        if (statusError) {
          console.error('❌ Webhook: Erro ao atualizar status da conversa:', statusError);
          throw statusError;
        }
      }
      if (inboxEventoId) {
        await chatwootInboxService.markProcessed(supabaseServer, organizationScope, inboxEventoId, { success: true, event: 'conversation_status_changed', convId });
      }
      return NextResponse.json({ success: true });
    }

    // Se temos uma conversa com ID e contact_id válido, fazer upsert idempotente
    let processedConvId: number | null = null;
    if (conversationData && conversationData.id) {
      const convId = parseOptionalInt(conversationData.id);
      const convContactId = contactId ?? parseOptionalInt(conversationData.contact_id ?? conversationData.contact?.id);

      if (convId !== null && convContactId !== null) {
        processedConvId = convId;
        const channel = mapChatwootChannel(payload.meta?.channel || conversationData.channel);
        const displayId = parseOptionalInt(conversationData.display_id);
        const convInboxId = parseOptionalInt(conversationData.inbox_id) ?? inboxId;

        const { error: convError } = await supabaseServer
          .from('chatwoot_conversations')
          .upsert({
            id: convId,
            user_id: userId,
            organizacao_id: organizacaoId,
            conexao_id: conexaoId || undefined,
            display_id: displayId,
            contact_id: convContactId,
            status: conversationData.status || 'open',
            inbox_id: convInboxId,
            channel: channel,
            updated_at: new Date().toISOString(),
          });

        if (convError) {
          console.error('❌ Webhook: Erro ao salvar conversa:', convError);
          throw convError;
        }
      }
    }

    // 4. Processar a Mensagem (caso o evento seja de criação/atualização de mensagem)
    let processedMsgId: number | null = null;
    if (event === 'message_created' || event === 'message_updated') {
      const msgId = parseOptionalInt(payload.id);
      const conversationId = parseOptionalInt(conversationData?.id || payload.conversation_id);
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
      const senderId = parseOptionalInt(payload.sender?.id);
      let senderType = payload.sender?.type || null;

      // Validação de domínio do sender_type contra constraint CHECK
      if (senderType && !['contact', 'user', 'agent'].includes(senderType)) {
        senderType = null;
      }

      const createdAt = payload.created_at || new Date().toISOString();

      if (conversationId !== null && msgId !== null) {
        processedMsgId = msgId;
        const { error: msgError } = await supabaseServer
          .from('chatwoot_messages')
          .upsert({
            id: msgId,
            user_id: userId,
            organizacao_id: organizacaoId,
            conexao_id: conexaoId || undefined,
            conversation_id: conversationId,
            content: content,
            message_type: msgType,
            sender_name: senderName,
            sender_id: senderId,
            sender_type: senderType,
            created_at: createdAt,
            updated_at: new Date().toISOString(),
          });

        if (msgError) {
          console.error('❌ Webhook: Erro ao salvar mensagem:', msgError);
          throw msgError;
        }
      }
    }

    if (inboxEventoId) {
      await chatwootInboxService.markProcessed(supabaseServer, organizationScope, inboxEventoId, {
        success: true,
        event,
        contactId,
        conversationId: processedConvId,
        messageId: processedMsgId,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (inboxEventoId && organizationScope) {
      try {
        await chatwootInboxService.markFailed(supabaseServer, organizationScope, inboxEventoId, error);
      } catch (markErr) {
        console.error('❌ Falha ao gravar status de falha no inbox Chatwoot:', markErr);
      }
    }

    const message = error instanceof Error ? error.message : 'Erro interno no processamento do webhook';
    console.error('❌ Erro de processamento no Webhook do Chatwoot:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
