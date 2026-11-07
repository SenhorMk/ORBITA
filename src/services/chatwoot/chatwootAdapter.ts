import type { VerifiedOrganizationScope } from '../../lib/verifiedOrganizationScope';
import { conexaoDesligada } from '../../lib/integrations/conexaoDesligada';
import {
  ChatwootCredentialsPayloadSchema,
  ChatwootConversationSchema,
  ChatwootMessageSchema,
  type ChatwootApiResult,
  type ChatwootConversation,
  type ChatwootMessage,
  type ChatwootPort,
} from './chatwootPort';

export const CHATWOOT_TIMEOUT_MS = 10_000;

/** Default Chatwoot Cloud origin used only when a connection omits `api_url`
 * (self-hosted deployments always provide their own). Overridable via env for
 * environments that need a different default without touching every connection. */
const DEFAULT_CHATWOOT_API_URL = process.env.CHATWOOT_DEFAULT_API_URL || 'https://app.chatwoot.com';

/** Connection-scoped configuration resolved from the credentials vault. Never
 * constructed directly from request/env primitives outside this module. */
interface ResolvedChatwootConnection {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly accountId: string;
  readonly conexaoId: string;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function parseRetryAfter(response: Response): number {
  const header = response.headers?.get('Retry-After');
  if (header) {
    const parsed = Number.parseInt(header, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 60;
}

function isPermanentStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Production adapter for the Chatwoot Application API. Every instance is bound
 * to one already-verified organization scope and one resolved connection.
 * There is no public constructor that accepts bare account/inbox primitives —
 * use {@link ChatwootAdapter.forScope} in production code.
 */
export class ChatwootAdapter implements ChatwootPort {
  private constructor(private readonly connection: ResolvedChatwootConnection) {}

  /**
   * Resolve the Chatwoot connection for a verified organization scope and
   * build a bound adapter. Returns `null` when the organization has no
   * connected, correctly-configured Chatwoot integration — callers must treat
   * that as `unconfigured`, never fall back to shared/global credentials.
   *
   * @param scope - Already-verified organization/actor pair.
   * @param conexaoId - Optional specific connection id; otherwise the
   *   organization's single Chatwoot connection is used.
   */
  static async forScope(scope: VerifiedOrganizationScope, conexaoId?: string): Promise<ChatwootAdapter | null> {
    // Imported lazily (not at module top level) so this module has no
    // import-time database/config side effect; only `forScope` touches storage.
    const { supabaseServer } = await import('../../lib/supabaseServer');
    const { credentialsVault } = await import('../../lib/integrations/credentialsVault');

    let connQuery = supabaseServer
      .from('conexoes_integracao')
      .select('id, metadata, status')
      .eq('organizacao_id', scope.organizationId)
      .eq('provedor', 'chatwoot');

    if (conexaoId) {
      connQuery = connQuery.eq('id', conexaoId);
    }

    const { data: conn } = await connQuery.maybeSingle();
    // Desligada (PRE-008) é o mesmo que não configurada: nenhum envio, status
    // ou sincronização sai por ela.
    if (!conn || conexaoDesligada(conn.status)) return null;

    const creds = await credentialsVault.getDecryptedCredentials(scope.organizationId, conn.id);
    if (!creds) return null;

    const parsed = ChatwootCredentialsPayloadSchema.safeParse(creds);
    if (!parsed.success) return null;

    return new ChatwootAdapter({
      apiUrl: parsed.data.api_url || DEFAULT_CHATWOOT_API_URL,
      apiToken: parsed.data.api_token,
      accountId: parsed.data.account_id,
      conexaoId: conn.id,
    });
  }

  /**
   * Build an adapter directly from a resolved connection, bypassing storage
   * lookup. Reserved for contract tests exercising the HTTP boundary against a
   * fake server; production code must use {@link ChatwootAdapter.forScope}.
   */
  static forTesting(connection: ResolvedChatwootConnection): ChatwootAdapter {
    return new ChatwootAdapter(connection);
  }

  /** The connection this adapter is bound to, for callers that persist by connection id. */
  get conexaoId(): string {
    return this.connection.conexaoId;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      api_access_token: this.connection.apiToken,
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    fetchImpl: typeof fetch,
  ): Promise<{ ok: true; response: Response } | { ok: false; failure: ChatwootApiResult<never> }> {
    let response: Response;
    try {
      response = await fetchImpl(`${this.connection.apiUrl}/api/v1/accounts/${this.connection.accountId}${path}`, {
        ...init,
        headers: this.headers(),
        signal: AbortSignal.timeout(CHATWOOT_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      const timeout = isTimeoutError(error);
      return {
        ok: false,
        failure: { _tag: 'ChatwootFailed', reason: timeout ? 'timeout' : 'network', retryable: true },
      };
    }

    if (response.status === 429) {
      return {
        ok: false,
        failure: {
          _tag: 'ChatwootFailed',
          reason: 'rate-limited',
          status: 429,
          retryAfterSeconds: parseRetryAfter(response),
          retryable: true,
        },
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        ok: false,
        failure: {
          _tag: 'ChatwootFailed',
          reason: 'http',
          status: response.status,
          message: errText || undefined,
          retryable: !isPermanentStatus(response.status),
        },
      };
    }

    return { ok: true, response };
  }

  async getConversations(fetchImpl: typeof fetch = fetch): Promise<ChatwootApiResult<ChatwootConversation[]>> {
    const result = await this.request('/conversations', { method: 'GET' }, fetchImpl);
    if (!result.ok) return result.failure;

    let raw: unknown;
    try {
      raw = await result.response.json();
    } catch {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false };
    }

    // A listagem vem em `data.payload` (4.19.1). Outro formato é resposta inválida, nunca "sem conversas".
    const envelope = raw as { data?: { payload?: unknown }; payload?: unknown } | null;
    const parsed = ChatwootConversationSchema.array().safeParse(envelope?.data?.payload ?? envelope?.payload);
    if (!parsed.success) {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false };
    }
    return { _tag: 'ChatwootSuccess', data: parsed.data };
  }

  async getMessages(
    conversationId: number,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ChatwootApiResult<ChatwootMessage[]>> {
    const result = await this.request(`/conversations/${conversationId}/messages`, { method: 'GET' }, fetchImpl);
    if (!result.ok) return result.failure;

    let raw: unknown;
    try {
      raw = await result.response.json();
    } catch {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false };
    }

    // Sem `payload` é resposta inválida, nunca "sem mensagens".
    const parsed = ChatwootMessageSchema.array().safeParse((raw as { payload?: unknown } | null)?.payload);
    if (!parsed.success) {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false };
    }
    return { _tag: 'ChatwootSuccess', data: parsed.data };
  }

  async sendMessage(
    conversationId: number,
    content: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ChatwootApiResult<ChatwootMessage>> {
    const result = await this.request(
      `/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content, message_type: 'outgoing', private: false }),
      },
      fetchImpl,
    );
    if (!result.ok) return result.failure;

    let raw: unknown;
    try {
      raw = await result.response.json();
    } catch {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false };
    }

    const parsed = ChatwootMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false };
    }
    return { _tag: 'ChatwootSuccess', data: parsed.data };
  }

  async toggleConversationStatus(
    conversationId: number,
    status: 'open' | 'resolved' | 'pending',
    fetchImpl: typeof fetch = fetch,
  ): Promise<ChatwootApiResult<unknown>> {
    const result = await this.request(
      `/conversations/${conversationId}/toggle_status`,
      { method: 'POST', body: JSON.stringify({ status }) },
      fetchImpl,
    );
    if (!result.ok) return result.failure;

    try {
      const data = await result.response.json();
      return { _tag: 'ChatwootSuccess', data };
    } catch {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false };
    }
  }
}
