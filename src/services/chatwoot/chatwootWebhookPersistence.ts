import { normalizeToE164 } from '@/lib/utils';
import type { ChatwootWebhookEvent } from '@/services/chatwoot/chatwootPort';
import { gravarContato, gravarConversa, gravarMensagem, type EscopoDeEscritaChatwoot } from '@/services/chatwoot/espelhoChatwoot';
import {
  FalhaDeIdentidadeChatwootError,
  resolverIdLocal,
  type EspelhoChatwootStore,
} from '@/services/chatwoot/identidadeChatwoot';

/** Os espelhos tocados por um evento, pelo UUID local. O id remoto não sai daqui. */
export interface PersistedWebhookEffects {
  readonly contatoIdLocal: string | null;
  readonly conversaIdLocal: string | null;
  readonly mensagemIdLocal: string | null;
}

export function mapChatwootChannel(channelStr?: string): string {
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

/** Normaliza o `message_type` bruto do Chatwoot para o enum local. */
export function mapChatwootMessageType(rawType: unknown): 'incoming' | 'outgoing' | 'system' | 'template' {
  if (rawType === 'outgoing' || rawType === 1 || rawType === '1') return 'outgoing';
  if (rawType === 'system' || rawType === 2 || rawType === '2') return 'system';
  if (rawType === 'template' || rawType === 3 || rawType === '3') return 'template';
  return 'incoming';
}

export function senderTypeConhecido(value: string | null | undefined): string | null {
  return value && ['contact', 'user', 'agent'].includes(value) ? value : null;
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

async function contatoJaEspelhado(store: EspelhoChatwootStore, escopo: EscopoDeEscritaChatwoot, idExterno: number): Promise<string> {
  const contato = await resolverIdLocal(store, escopo, 'contato', idExterno);
  if (contato._tag === 'IdLocalResolvido') return contato.idLocal;
  throw new FalhaDeIdentidadeChatwootError(
    'conversa',
    contato.falha === 'IdentidadeNaoEncontrada' ? 'PaiNaoEspelhado' : contato.falha,
  );
}

/** Contato e conversa de um evento verificado, gravados pelo UUID local na conexão do escopo. */
async function persistWebhookContactAndConversation(
  store: EspelhoChatwootStore,
  escopo: EscopoDeEscritaChatwoot,
  payload: ChatwootWebhookEvent,
  inboxId: number | null,
): Promise<{ contatoIdLocal: string | null; conversaIdLocal: string | null }> {
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
  let contatoIdLocal: string | null = null;
  if (contactId !== null) {
    contatoIdLocal = await gravarContato(store, escopo, {
      idExterno: contactId,
      nome: contactName || 'Cliente WhatsApp',
      email: contactEmail || null,
      telefone: contactPhone || null,
      telefoneNormalizado: normalizeToE164(contactPhone),
      avatarUrl: contactAvatar || null,
    });
  }

  let conversaIdLocal: string | null = null;
  const convId = parseOptionalInt(conversationData?.id);
  const convContactId = contactId ?? parseOptionalInt(conversationData?.contact_id ?? conversationData?.contact?.id);
  if (convId !== null && convContactId !== null) {
    // O contato da conversa é o gravado acima ou um já espelhado nesta conexão.
    const contatoDaConversa = contatoIdLocal ?? (await contatoJaEspelhado(store, escopo, convContactId));
    conversaIdLocal = await gravarConversa(store, escopo, {
      idExterno: convId,
      contatoIdLocal: contatoDaConversa,
      contatoIdExterno: convContactId,
      displayId: parseOptionalInt(conversationData?.display_id),
      status: conversationData?.status || 'open',
      inboxId: parseOptionalInt(conversationData?.inbox_id) ?? inboxId,
      canal: mapChatwootChannel(payload.meta?.channel || conversationData?.channel),
    });
  }

  return { contatoIdLocal, conversaIdLocal };
}

/** A mensagem de um `message_created`/`message_updated`, na conversa desta conexão. */
async function persistWebhookMessage(
  store: EspelhoChatwootStore,
  escopo: EscopoDeEscritaChatwoot,
  payload: ChatwootWebhookEvent,
): Promise<string | null> {
  const msgId = parseOptionalInt(payload.id);
  const conversationId = parseOptionalInt(payload.conversation?.id || payload.conversation_id);
  if (conversationId === null || msgId === null) return null;

  return gravarMensagem(store, escopo, {
    idExterno: msgId,
    conversaIdExterno: conversationId,
    conteudo: payload.content || '',
    tipo: mapChatwootMessageType(payload.message_type),
    remetenteNome: payload.sender?.name || null,
    remetenteId: parseOptionalInt(payload.sender?.id),
    remetenteTipo: senderTypeConhecido(payload.sender?.type),
    criadaEm: payload.created_at || new Date().toISOString(),
  }, payload.event === 'message_created' ? 'preservar' : 'sobrescrever');
}

/** Apply every side effect for one verified, non-duplicate webhook event. */
export async function persistWebhookEffects(
  store: EspelhoChatwootStore,
  escopo: EscopoDeEscritaChatwoot,
  payload: ChatwootWebhookEvent,
  inboxId: number | null,
): Promise<PersistedWebhookEffects> {
  const { contatoIdLocal, conversaIdLocal } = await persistWebhookContactAndConversation(store, escopo, payload, inboxId);

  let mensagemIdLocal: string | null = null;
  if (payload.event === 'message_created' || payload.event === 'message_updated') {
    mensagemIdLocal = await persistWebhookMessage(store, escopo, payload);
  }

  return { contatoIdLocal, conversaIdLocal, mensagemIdLocal };
}
