import { z } from 'zod';

/**
 * Application-owned boundary schemas for the Chatwoot Application API.
 * See `docs/integrations/chatwoot-contract.md` for the verified provider contract.
 */

/** Private credential bundle stored per organization connection. */
export const ChatwootCredentialsPayloadSchema = z.object({
  api_url: z.string().url().optional(),
  api_token: z.string().min(1),
  account_id: z.string().min(1),
  webhook_secret: z.string().min(1),
});
export type ChatwootCredentialsPayload = z.infer<typeof ChatwootCredentialsPayloadSchema>;

/** A Chatwoot contact as returned by the Application API. */
export const ChatwootContactSchema = z.object({
  id: z.coerce.number().int(),
  name: z.string().optional(),
  email: z.string().optional().nullable(),
  phone_number: z.string().optional().nullable(),
  avatar_url: z.string().optional().nullable(),
  thumbnail: z.string().optional().nullable(),
});
export type ChatwootContact = z.infer<typeof ChatwootContactSchema>;

/** A Chatwoot conversation as returned by the Application API. */
export const ChatwootConversationSchema = z.object({
  id: z.coerce.number().int(),
  display_id: z.coerce.number().int().optional(),
  contact_id: z.coerce.number().int().optional(),
  // `snoozed` só se lê: a ORBITA não adia conversa, mas o agente pode adiar no Chatwoot.
  status: z.enum(['open', 'resolved', 'pending', 'snoozed']).default('open'),
  inbox_id: z.coerce.number().int().optional(),
  channel: z.string().optional(),
  channel_type: z.string().optional(),
  /** Versão do provedor, quando presente. Sem ela, o sync não passa de uma revisão comprovada. */
  updated_at: z.union([z.string(), z.number()]).optional(),
  meta: z
    .object({
      sender: ChatwootContactSchema.optional(),
      channel: z.string().optional(),
    })
    .optional(),
});
export type ChatwootConversation = z.infer<typeof ChatwootConversationSchema>;

/** A Chatwoot message as returned by the Application API. */
export const ChatwootMessageSchema = z.object({
  id: z.coerce.number().int(),
  content: z.string().optional().nullable(),
  message_type: z.union([z.enum(['incoming', 'outgoing', 'system', 'template']), z.number(), z.string()]).optional(),
  // Nota privada (MSG-009): o recibo da nota precisa provar `true`; o sync a ignora.
  private: z.boolean().optional(),
  sender: z
    .object({
      id: z.coerce.number().int().optional(),
      name: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
  // A API responde segundos desde a época (4.19.1); o webhook, ISO. Daqui para dentro é sempre ISO.
  created_at: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === 'number' ? new Date(v * 1000).toISOString() : v))
    .optional(),
  updated_at: z.union([z.string(), z.number()]).optional(),
});
export type ChatwootMessage = z.infer<typeof ChatwootMessageSchema>;

/** A contact fragment as embedded inside webhook conversation/meta payloads,
 * where `id` may legitimately be absent for some event shapes. */
const ChatwootWebhookContactFragmentSchema = ChatwootContactSchema.partial();

const IdDoChatwootSchema = z.union([z.number(), z.string()]);
const ContatoDaConversaSchema = z.object({
  meta: z.object({ sender: ChatwootWebhookContactFragmentSchema.optional() }).optional(),
  contact_inbox: z.object({ contact_id: IdDoChatwootSchema.optional() }).optional(),
});

/** O envelope como o Chatwoot manda. Cada família de evento tem um formato. */
const EventoDoChatwootBrutoSchema = z.object({
  event: z.string().min(1),
  account: z.object({ id: z.coerce.number().int() }),
  id: IdDoChatwootSchema.optional(),
  // Mensagem só com anexo chega com `content: null`.
  content: z.string().nullable().optional(),
  message_type: z.union([z.string(), z.number()]).optional(),
  conversation_id: IdDoChatwootSchema.optional(),
  created_at: z.union([z.string(), z.number()]).optional(),
  /** Versão do provedor, quando presente: marca a revisão do evento (MSG-005). */
  updated_at: z.union([z.string(), z.number()]).optional(),
  private: z.boolean().optional(),
  inbox: z.object({ id: IdDoChatwootSchema.optional() }).optional(),
  // Só nos eventos `conversation_*`: a própria conversa vem no topo.
  status: z.string().optional(),
  inbox_id: IdDoChatwootSchema.optional(),
  channel: z.string().optional(),
  contact_inbox: ContatoDaConversaSchema.shape.contact_inbox,
  conversation: ContatoDaConversaSchema.extend({
    id: IdDoChatwootSchema.optional(),
    display_id: IdDoChatwootSchema.optional(),
    contact_id: IdDoChatwootSchema.optional(),
    status: z.string().optional(),
    updated_at: z.union([z.string(), z.number()]).optional(),
    inbox_id: IdDoChatwootSchema.optional(),
    channel: z.string().optional(),
    contact: ChatwootWebhookContactFragmentSchema.optional(),
  }).optional(),
  sender: z
    .object({
      id: IdDoChatwootSchema.optional(),
      name: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
  meta: z
    .object({
      sender: ChatwootWebhookContactFragmentSchema.optional(),
      channel: z.string().optional(),
    })
    .optional(),
});

/**
 * Formato único para o resto da aplicação, conferido contra o Chatwoot 4.19.1 real
 * (`__fixtures__/chatwoot-v4.19.1-webhooks.json`): `conversation_*` traz a conversa
 * no topo; o contato fica em `conversation.meta.sender`; e o `sender` de um contato
 * vem sem `type`. Esse `type` só é preenchido com prova: mensagem de entrada cujo
 * remetente é o contato da própria conversa. Sem ela, a classificação segue
 * inconclusiva. Aplicar de novo sobre o resultado não muda nada: a inbox grava o
 * evento já normalizado, e o worker relê por aqui.
 */
function normalizarEventoDoChatwoot(bruto: z.infer<typeof EventoDoChatwootBrutoSchema>) {
  const { status, inbox_id, channel, contact_inbox, conversation, content, ...evento } = bruto;
  const noTopo = !conversation && bruto.event.startsWith('conversation_');
  const { meta: metaDaConversa, contact_inbox: inboxDoContato, ...conversa } = conversation
    ?? (noTopo ? { id: bruto.id, status, inbox_id, channel, updated_at: bruto.updated_at, contact_inbox } : {});
  const remetenteDaConversa = bruto.meta?.sender ?? metaDaConversa?.sender;
  const contatoId = conversa.contact_id ?? inboxDoContato?.contact_id ?? remetenteDaConversa?.id;
  const remetenteEhOContato = bruto.sender?.id !== undefined && contatoId !== undefined
    && String(bruto.sender.id) === String(contatoId);
  const deEntrada = bruto.message_type === 'incoming' || bruto.message_type === 0;
  return {
    ...evento,
    ...(content === null || content === undefined ? {} : { content }),
    ...(conversation || noTopo ? { conversation: { ...conversa, ...(contatoId === undefined ? {} : { contact_id: contatoId }) } } : {}),
    ...(remetenteDaConversa ? { meta: { ...bruto.meta, sender: remetenteDaConversa } } : {}),
    ...(bruto.sender ? { sender: { ...bruto.sender, type: bruto.sender.type ?? (deEntrada && remetenteEhOContato ? 'contact' : undefined) } } : {}),
  };
}

/** Inbound webhook event envelope. Every field except `event` and `account` is optional
 * because Chatwoot sends materially different shapes per event type. */
export const ChatwootWebhookEventSchema = EventoDoChatwootBrutoSchema.transform(normalizarEventoDoChatwoot);
export type ChatwootWebhookEvent = z.infer<typeof ChatwootWebhookEventSchema>;

/** Typed, exhaustive outcome of every Chatwoot Application API call. */
export type ChatwootApiResult<T> =
  | { readonly _tag: 'ChatwootSuccess'; readonly data: T }
  | {
      readonly _tag: 'ChatwootFailed';
      readonly reason: 'http' | 'invalid-response' | 'network' | 'rate-limited' | 'timeout' | 'unconfigured';
      readonly status?: number;
      readonly retryAfterSeconds?: number;
      readonly message?: string;
      /** Whether a caller may safely retry this specific failure. 401/403 and
       * `unconfigured`/`invalid-response` are permanent; network/timeout/5xx/429 are transient. */
      readonly retryable: boolean;
    };

/**
 * Application-owned port for the Chatwoot provider. Every implementation is
 * bound to one already-verified organization scope and, optionally, one
 * connection; there is no factory that accepts bare account/inbox primitives.
 */
export interface ChatwootPort {
  /** List conversations visible to the connected account. */
  getConversations(): Promise<ChatwootApiResult<ChatwootConversation[]>>;
  /** List messages for one conversation. */
  getMessages(conversationId: number): Promise<ChatwootApiResult<ChatwootMessage[]>>;
  /** Send an outgoing message into a conversation. */
  sendMessage(conversationId: number, content: string): Promise<ChatwootApiResult<ChatwootMessage>>;
  /** Change a conversation's status. */
  toggleConversationStatus(
    conversationId: number,
    status: 'open' | 'resolved' | 'pending',
  ): Promise<ChatwootApiResult<unknown>>;
}
