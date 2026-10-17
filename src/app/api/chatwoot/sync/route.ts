import { NextResponse } from 'next/server';
import { ChatwootAdapter } from '../../../../services/chatwoot/chatwootAdapter';
import { registerChatwootInboxIfNeeded } from '../../../../services/chatwoot/chatwootInboxRegistration';
import type { ChatwootConversation, ChatwootMessage } from '../../../../services/chatwoot/chatwootPort';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { normalizeToE164 } from '../../../../lib/utils';
import { registroDoSacSupabase, vincularSacAoErp } from '../../../../services/integrationService';
import { recordAuditEvent } from '../../../../services/auditService';
import { criarAuditoriaComercial } from '../../../../services/auditoriaComercial';
import { getCorrelationId } from '../../../../lib/observability/correlation';
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

/** Sincroniza o contato remetente de uma conversa. Retorna `true` quando persistido com sucesso. */
async function syncChatwootContact(
  scope: VerifiedOrganizationScope,
  sender: NonNullable<NonNullable<ChatwootConversation['meta']>['sender']>,
): Promise<boolean> {
  const contactId = sender.id;
  const { error: contactError } = await upsertChatwootRecord(scope, 'chatwoot_contacts', {
    id: contactId,
    name: sender.name || 'Cliente Sem Nome',
    email: sender.email || null,
    phone_number: sender.phone_number || null,
    phone_normalizado: normalizeToE164(sender.phone_number || undefined),
    avatar_url: sender.avatar_url || sender.thumbnail || null,
  });

  if (contactError) {
    console.error(`❌ Erro ao salvar contato ${contactId}:`, contactError);
    return false;
  }
  return true;
}

/** Sincroniza a conversa (com canal mapeado) associada a um contato já persistido. */
async function syncChatwootConversation(
  scope: VerifiedOrganizationScope,
  rawConv: ChatwootConversation,
  contactId: number,
): Promise<boolean> {
  const { error: convError } = await upsertChatwootRecord(scope, 'chatwoot_conversations', {
    id: rawConv.id,
    display_id: rawConv.display_id,
    contact_id: contactId,
    status: rawConv.status || 'open',
    inbox_id: rawConv.inbox_id || null,
    channel: mapChatwootChannel(rawConv.meta?.channel || rawConv.channel_type),
    updated_at: new Date().toISOString(),
  });

  if (convError) {
    console.error(`❌ Erro ao salvar conversa ${rawConv.id}:`, convError);
    return false;
  }
  return true;
}

/** Normaliza o `message_type` bruto do Chatwoot para o enum local. */
function mapChatwootMessageType(rawType: ChatwootMessage['message_type']): 'incoming' | 'outgoing' | 'system' | 'template' {
  if (rawType === 1 || rawType === 'outgoing' || rawType === '1') return 'outgoing';
  if (rawType === 2 || rawType === 'system' || rawType === '2') return 'system';
  if (rawType === 3 || rawType === 'template' || rawType === '3') return 'template';
  return 'incoming';
}

/** Sincroniza todas as mensagens de uma conversa. Retorna a contagem de mensagens persistidas. */
async function syncChatwootMessages(
  adapter: ChatwootAdapter,
  scope: VerifiedOrganizationScope,
  conversationId: number,
): Promise<number> {
  const messagesResult = await adapter.getMessages(conversationId);
  if (messagesResult._tag !== 'ChatwootSuccess') {
    console.error(`❌ Erro ao consultar mensagens da conversa ${conversationId}:`, messagesResult.reason);
    return 0;
  }

  let messagesCount = 0;
  for (const rawMsg of messagesResult.data) {
    let senderType = rawMsg.sender?.type || null;
    if (senderType && !['contact', 'user', 'agent'].includes(senderType)) {
      senderType = null;
    }

    const { error: msgError } = await upsertChatwootRecord(scope, 'chatwoot_messages', {
      id: rawMsg.id,
      conversation_id: conversationId,
      content: rawMsg.content || '',
      message_type: mapChatwootMessageType(rawMsg.message_type),
      sender_name: rawMsg.sender?.name || null,
      sender_id: rawMsg.sender?.id || null,
      sender_type: senderType,
      created_at: rawMsg.created_at || new Date().toISOString(),
    });

    if (msgError) {
      console.error(`❌ Erro ao salvar mensagem ${rawMsg.id}:`, msgError);
      continue;
    }
    messagesCount++;
  }
  return messagesCount;
}

/** Sincroniza uma única conversa (registro de inbox, contato, conversa e mensagens). */
async function syncChatwootConversationTree(
  adapter: ChatwootAdapter,
  scope: VerifiedOrganizationScope,
  rawConv: ChatwootConversation,
): Promise<{ contacts: number; conversations: number; messages: number }> {
  // Registrar/confirmar o mapeamento inbox->organização usando uma conversa obtida
  // via chamada autenticada com as credenciais da própria organização — nunca a
  // partir de um payload de webhook não verificado.
  if (rawConv.inbox_id) {
    await registerChatwootInboxIfNeeded(supabaseServer, scope, {
      conexaoId: adapter.conexaoId,
      inboxId: rawConv.inbox_id,
    });
  }

  const sender = rawConv.meta?.sender;
  if (!sender) return { contacts: 0, conversations: 0, messages: 0 };

  const contactSynced = await syncChatwootContact(scope, sender);
  if (!contactSynced) return { contacts: 0, conversations: 0, messages: 0 };

  const conversationSynced = await syncChatwootConversation(scope, rawConv, sender.id);
  if (!conversationSynced) return { contacts: 1, conversations: 0, messages: 0 };

  const messages = await syncChatwootMessages(adapter, scope, rawConv.id);
  return { contacts: 1, conversations: 1, messages };
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

    // 1. Obter conversas da API do Chatwoot usando adapter vinculado ao escopo verificado
    const adapter = await ChatwootAdapter.forScope(scope);
    if (!adapter) {
      return NextResponse.json({ success: false, error: 'Integração Chatwoot não configurada' }, { status: 409 });
    }

    const conversationsResult = await adapter.getConversations();
    if (conversationsResult._tag !== 'ChatwootSuccess') {
      return NextResponse.json(
        { success: false, error: conversationsResult.message || `Falha ao consultar Chatwoot (${conversationsResult.reason})` },
        { status: conversationsResult.status || 502 },
      );
    }
    const rawConversations: ChatwootConversation[] = conversationsResult.data;

    let contactsCount = 0;
    let conversationsCount = 0;
    let messagesCount = 0;

    for (const rawConv of rawConversations) {
      const result = await syncChatwootConversationTree(adapter, scope, rawConv);
      contactsCount += result.contacts;
      conversationsCount += result.conversations;
      messagesCount += result.messages;
    }

    // 2. Auto-registro SAC → ERP: qualquer membro que sincroniza o SAC
    // (`organization:access`), só cria cliente novo, sob trava, e audita.
    const auditar = criarAuditoriaComercial((s, input) => recordAuditEvent(supabaseServer, s, input));
    let clientes: { criados: number; falhas: number } | null = null;
    try {
      const vinculo = await vincularSacAoErp(scope, registroDoSacSupabase, auditar, getCorrelationId(request));
      clientes = { criados: vinculo.criados, falhas: vinculo.falhas };
    } catch (erro: unknown) {
      // As conversas já foram espelhadas: a falha do vínculo não desfaz isso,
      // e a resposta diz que ele não foi feito em vez de fingir sucesso.
      console.error('❌ Erro no vínculo SAC-ERP:', erro instanceof Error ? erro.name : 'UnknownError');
    }

    return NextResponse.json({
      success: true,
      stats: {
        contacts: contactsCount,
        conversations: conversationsCount,
        messages: messagesCount,
      },
      clientes: clientes ?? { criados: 0, falhas: null, vinculo: 'nao_concluido' },
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
