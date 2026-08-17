import { ChatwootContact, ChatwootConversation, ChatwootMessage } from '../types';

export class ChatwootService {
  private apiUrl = process.env.CHATWOOT_API_URL || 'https://app.chatwoot.com';
  private apiToken = process.env.CHATWOOT_API_TOKEN;
  private accountId = process.env.CHATWOOT_ACCOUNT_ID;

  private isConfigured(): boolean {
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

  /**
   * Obtém conversas diretamente da API do Chatwoot
   */
  async getConversationsFromApi(): Promise<any[]> {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const response = await fetch(
        `${this.apiUrl}/api/v1/accounts/${this.accountId}/conversations`,
        {
          method: 'GET',
          headers: this.getHeaders(),
          next: { revalidate: 0 },
        }
      );

      if (!response.ok) {
        throw new Error(`Erro na API Chatwoot: ${response.statusText}`);
      }

      const data = await response.json();
      return data.payload || [];
    } catch (error) {
      console.error('❌ Erro ao buscar conversas no Chatwoot:', error);
      return [];
    }
  }

  /**
   * Obtém mensagens de uma conversa específica diretamente da API do Chatwoot
   */
  async getMessagesFromApi(conversationId: number): Promise<any[]> {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const response = await fetch(
        `${this.apiUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
        {
          method: 'GET',
          headers: this.getHeaders(),
          next: { revalidate: 0 },
        }
      );

      if (!response.ok) {
        throw new Error(`Erro na API Chatwoot: ${response.statusText}`);
      }

      const data = await response.json();
      return data.payload || [];
    } catch (error) {
      console.error(`❌ Erro ao buscar mensagens para conversa ${conversationId}:`, error);
      return [];
    }
  }

  /**
   * Envia uma mensagem em uma conversa específica via API do Chatwoot
   */
  async sendMessageToApi(conversationId: number, content: string): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error('Chatwoot API não configurada. Configure a chave de API nas configurações.');
    }

    const response = await fetch(
      `${this.apiUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          content,
          message_type: 'outgoing',
          private: false,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro ao enviar mensagem no Chatwoot (${response.status}): ${errText}`);
    }

    return await response.json();
  }

  /**
   * Altera o status da conversa no Chatwoot ('open', 'resolved', 'pending')
   */
  async toggleStatusInApi(conversationId: number, status: 'open' | 'resolved' | 'pending'): Promise<any> {
    if (!this.isConfigured()) {
      return { success: true, status };
    }

    const response = await fetch(
      `${this.apiUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/toggle_status`,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ status }),
      }
    );

    if (!response.ok) {
      throw new Error(`Erro ao alterar status no Chatwoot: ${response.statusText}`);
    }

    return await response.json();
  }

  async toggleConversationStatus(conversationId: number, status: 'open' | 'resolved' | 'pending'): Promise<any> {
    return this.toggleStatusInApi(conversationId, status);
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

export const chatwootService = new ChatwootService();
