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
  status: z.enum(['open', 'resolved', 'pending']).default('open'),
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
  sender: z
    .object({
      id: z.coerce.number().int().optional(),
      name: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
  created_at: z.string().optional(),
  updated_at: z.union([z.string(), z.number()]).optional(),
});
export type ChatwootMessage = z.infer<typeof ChatwootMessageSchema>;

/** A contact fragment as embedded inside webhook conversation/meta payloads,
 * where `id` may legitimately be absent for some event shapes. */
const ChatwootWebhookContactFragmentSchema = ChatwootContactSchema.partial();

/** Inbound webhook event envelope. Every field except `event` and `account` is optional
 * because Chatwoot sends materially different shapes per event type. */
export const ChatwootWebhookEventSchema = z.object({
  event: z.string().min(1),
  account: z.object({ id: z.coerce.number().int() }),
  id: z.union([z.number(), z.string()]).optional(),
  content: z.string().optional(),
  message_type: z.union([z.string(), z.number()]).optional(),
  conversation_id: z.union([z.number(), z.string()]).optional(),
  created_at: z.string().optional(),
  /** Versão do provedor, quando presente: marca a revisão do evento (MSG-005). */
  updated_at: z.union([z.string(), z.number()]).optional(),
  private: z.boolean().optional(),
  inbox: z.object({ id: z.union([z.number(), z.string()]).optional() }).optional(),
  conversation: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
      display_id: z.union([z.number(), z.string()]).optional(),
      contact_id: z.union([z.number(), z.string()]).optional(),
      status: z.string().optional(),
      updated_at: z.union([z.string(), z.number()]).optional(),
      inbox_id: z.union([z.number(), z.string()]).optional(),
      channel: z.string().optional(),
      contact: ChatwootWebhookContactFragmentSchema.optional(),
    })
    .optional(),
  sender: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
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
