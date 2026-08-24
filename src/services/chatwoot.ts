import { z } from 'zod';
import { supabaseServer } from '../lib/supabaseServer';
import { credentialsVault } from '../lib/integrations/credentialsVault';

const CHATWOOT_TIMEOUT_MS = 10_000;

export const ChatwootCredentialsPayloadSchema = z.object({
  api_url: z.string().url().optional(),
  api_token: z.string().min(1),
  account_id: z.string().min(1),
  webhook_secret: z.string().optional(),
});

export type ChatwootCredentialsPayload = z.infer<typeof ChatwootCredentialsPayloadSchema>;

export type ChatwootApiResult<T> =
  | { readonly _tag: 'ChatwootSuccess'; readonly data: T }
  | {
      readonly _tag: 'ChatwootFailed';
      readonly reason: 'http' | 'invalid-response' | 'network' | 'rate-limited' | 'timeout' | 'unconfigured';
      readonly status?: number;
      readonly retryAfterSeconds?: number;
      readonly message?: string;
    };

export interface ChatwootConfig {
  apiUrl: string;
  apiToken: string;
  accountId: string;
}

const orgChatwootCache = new Map<string, ChatwootClient>();

export class ChatwootClient {
  private apiUrl: string;
  private apiToken?: string;
  private accountId?: string;
  private readonly organizacaoId?: string;
  private readonly conexaoId?: string;

  constructor(config?: Partial<ChatwootConfig>, organizacaoId?: string, conexaoId?: string) {
    this.apiUrl = config?.apiUrl || process.env.CHATWOOT_API_URL || 'https://app.chatwoot.com';
    this.apiToken = config?.apiToken || process.env.CHATWOOT_API_TOKEN;
    this.accountId = config?.accountId || process.env.CHATWOOT_ACCOUNT_ID;
    this.organizacaoId = organizacaoId;
    this.conexaoId = conexaoId;
  }

  static async forOrganization(organizacaoId: string, conexaoId?: string): Promise<ChatwootClient> {
    const key = `${organizacaoId}:${conexaoId || 'primary'}`;
    const cached = orgChatwootCache.get(key);
    if (cached) return cached;

    // Buscar credenciais no vault
    let connQuery = supabaseServer
      .from('conexoes_integracao')
      .select('id, metadata')
      .eq('organizacao_id', organizacaoId)
      .eq('provedor', 'chatwoot');

    if (conexaoId) {
      connQuery = connQuery.eq('id', conexaoId);
    }

    const { data: conn } = await connQuery.maybeSingle();

    if (conn) {
      const creds = await credentialsVault.getDecryptedCredentials(organizacaoId, conn.id);
      if (creds) {
        const parsed = ChatwootCredentialsPayloadSchema.safeParse(creds);
        if (parsed.success) {
          const client = new ChatwootClient({
            apiUrl: parsed.data.api_url,
            apiToken: parsed.data.api_token,
            accountId: parsed.data.account_id,
          }, organizacaoId, conn.id);
          orgChatwootCache.set(key, client);
          return client;
        }
      }
    }

    const client = new ChatwootClient(undefined, organizacaoId, conexaoId);
    orgChatwootCache.set(key, client);
    return client;
  }

  isConfigured(): boolean {
    return (
      !!this.apiToken &&
      this.apiToken !== 'sua_chave_de_api_chatwoot_aqui' &&
      !!this.accountId &&
      this.accountId !== 'seu_id_de_conta_aqui'
    );
  }

  private getHeaders() {
    return {
      'Content-Type': 'application/json',
      'api_access_token': this.apiToken || '',
    };
  }

  private parseRetryAfter(response: Response): number {
    const header = response.headers?.get('Retry-After');
    if (header) {
      const parsed = Number.parseInt(header, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 60;
  }

  /**
   * Obtém conversas diretamente da API do Chatwoot
   */
  async getConversationsFromApi(fetchImpl: typeof fetch = fetch): Promise<unknown[]> {
    const result = await this.getConversations(fetchImpl);
    return result._tag === 'ChatwootSuccess' ? result.data : [];
  }

  async getConversations(fetchImpl: typeof fetch = fetch): Promise<ChatwootApiResult<unknown[]>> {
    if (!this.isConfigured()) {
      return { _tag: 'ChatwootFailed', reason: 'unconfigured', message: 'Chatwoot não configurado' };
    }

    let response: Response;
    try {
      response = await fetchImpl(
        `${this.apiUrl}/api/v1/accounts/${this.accountId}/conversations`,
        {
          method: 'GET',
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(CHATWOOT_TIMEOUT_MS),
        }
      );
    } catch (error: unknown) {
      const isTimeout = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
      return { _tag: 'ChatwootFailed', reason: isTimeout ? 'timeout' : 'network' };
    }

    if (response.status === 429) {
      return {
        _tag: 'ChatwootFailed',
        reason: 'rate-limited',
        status: 429,
        retryAfterSeconds: this.parseRetryAfter(response),
      };
    }

    if (!response.ok) {
      return { _tag: 'ChatwootFailed', reason: 'http', status: response.status };
    }

    try {
      const data = await response.json();
      return { _tag: 'ChatwootSuccess', data: data.payload || [] };
    } catch {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response' };
    }
  }

  /**
   * Obtém mensagens de uma conversa específica diretamente da API do Chatwoot
   */
  async getMessagesFromApi(conversationId: number, fetchImpl: typeof fetch = fetch): Promise<unknown[]> {
    const result = await this.getMessages(conversationId, fetchImpl);
    return result._tag === 'ChatwootSuccess' ? result.data : [];
  }

  async getMessages(conversationId: number, fetchImpl: typeof fetch = fetch): Promise<ChatwootApiResult<unknown[]>> {
    if (!this.isConfigured()) {
      return { _tag: 'ChatwootFailed', reason: 'unconfigured', message: 'Chatwoot não configurado' };
    }

    let response: Response;
    try {
      response = await fetchImpl(
        `${this.apiUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
        {
          method: 'GET',
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(CHATWOOT_TIMEOUT_MS),
        }
      );
    } catch (error: unknown) {
      const isTimeout = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
      return { _tag: 'ChatwootFailed', reason: isTimeout ? 'timeout' : 'network' };
    }

    if (response.status === 429) {
      return {
        _tag: 'ChatwootFailed',
        reason: 'rate-limited',
        status: 429,
        retryAfterSeconds: this.parseRetryAfter(response),
      };
    }

    if (!response.ok) {
      return { _tag: 'ChatwootFailed', reason: 'http', status: response.status };
    }

    try {
      const data = await response.json();
      return { _tag: 'ChatwootSuccess', data: data.payload || [] };
    } catch {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response' };
    }
  }

  /**
   * Envia uma mensagem em uma conversa específica via API do Chatwoot
   */
  async sendMessageToApi(conversationId: number, content: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
    const result = await this.sendMessage(conversationId, content, fetchImpl);
    if (result._tag === 'ChatwootSuccess') {
      return result.data;
    }
    throw new Error(result.message || `Erro no Chatwoot: ${result.reason}`);
  }

  async sendMessage(conversationId: number, content: string, fetchImpl: typeof fetch = fetch): Promise<ChatwootApiResult<unknown>> {
    if (!this.isConfigured()) {
      return { _tag: 'ChatwootFailed', reason: 'unconfigured', message: 'Chatwoot API não configurada.' };
    }

    let response: Response;
    try {
      response = await fetchImpl(
        `${this.apiUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
        {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            content,
            message_type: 'outgoing',
            private: false,
          }),
          signal: AbortSignal.timeout(CHATWOOT_TIMEOUT_MS),
        }
      );
    } catch (error: unknown) {
      const isTimeout = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
      return { _tag: 'ChatwootFailed', reason: isTimeout ? 'timeout' : 'network' };
    }

    if (response.status === 429) {
      return {
        _tag: 'ChatwootFailed',
        reason: 'rate-limited',
        status: 429,
        retryAfterSeconds: this.parseRetryAfter(response),
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        _tag: 'ChatwootFailed',
        reason: 'http',
        status: response.status,
        message: `Erro ao enviar mensagem no Chatwoot (${response.status}): ${errText}`,
      };
    }

    try {
      const data = await response.json();
      return { _tag: 'ChatwootSuccess', data };
    } catch {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response' };
    }
  }

  /**
   * Altera o status da conversa no Chatwoot ('open', 'resolved', 'pending')
   */
  async toggleStatusInApi(conversationId: number, status: 'open' | 'resolved' | 'pending', fetchImpl: typeof fetch = fetch): Promise<unknown> {
    const result = await this.toggleConversationStatus(conversationId, status, fetchImpl);
    if (result._tag === 'ChatwootSuccess') {
      return result.data;
    }
    throw new Error(result.message || `Erro no Chatwoot: ${result.reason}`);
  }

  async toggleConversationStatus(
    conversationId: number,
    status: 'open' | 'resolved' | 'pending',
    fetchImpl: typeof fetch = fetch,
  ): Promise<ChatwootApiResult<unknown>> {
    if (!this.isConfigured()) {
      return { _tag: 'ChatwootSuccess', data: { success: true, status } };
    }

    let response: Response;
    try {
      response = await fetchImpl(
        `${this.apiUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/toggle_status`,
        {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(CHATWOOT_TIMEOUT_MS),
        }
      );
    } catch (error: unknown) {
      const isTimeout = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
      return { _tag: 'ChatwootFailed', reason: isTimeout ? 'timeout' : 'network' };
    }

    if (response.status === 429) {
      return {
        _tag: 'ChatwootFailed',
        reason: 'rate-limited',
        status: 429,
        retryAfterSeconds: this.parseRetryAfter(response),
      };
    }

    if (!response.ok) {
      return {
        _tag: 'ChatwootFailed',
        reason: 'http',
        status: response.status,
        message: `Erro ao alterar status no Chatwoot: ${response.statusText}`,
      };
    }

    try {
      const data = await response.json();
      return { _tag: 'ChatwootSuccess', data };
    } catch {
      return { _tag: 'ChatwootFailed', reason: 'invalid-response' };
    }
  }

  /**
   * Normaliza números telefônicos para o padrão E.164 (+55...)
   */
  normalizePhoneNumber(phone: string): string {
    if (!phone) return '';
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10 || cleaned.length === 11) {
      cleaned = `55${cleaned}`;
    }
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  }
}

export const chatwootService = new ChatwootClient();
