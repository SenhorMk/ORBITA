import crypto from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { redactSensitiveData } from '../lib/integrations/credentialsVault';

export interface ChatwootInboxEventRecord {
  id: string;
  organizacao_id: string;
  conexao_id?: string | null;
  user_id?: string | null;
  inbox_id?: number | null;
  idempotency_key: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'ignored';
  attempts: number;
  last_error?: string | null;
  response_body?: Record<string, unknown> | null;
  processed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterChatwootInboxResult {
  eventoId: string;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'ignored';
  isDuplicate: boolean;
  cachedResponse?: Record<string, unknown> | null;
}

/**
 * Computa uma chave determinística de idempotência para o evento Chatwoot.
 * Utiliza o tipo de evento e os identificadores canônicos do payload
 * (mensagem, conversa, status ou contato) para evitar duplicação em rede.
 */
export function generateChatwootIdempotencyKey(event: unknown, fallbackPrefix = 'chatwoot'): string {
  if (typeof event === 'object' && event !== null) {
    const record = event as Record<string, unknown>;
    const eventName = String(record.event || record.type || '').trim().toLowerCase();
    const conversation = record.conversation as Record<string, unknown> | undefined;

    if (eventName === 'message_created' || eventName === 'message_updated') {
      const msgId = record.id;
      const convId = conversation?.id || record.conversation_id;
      if (msgId !== undefined && msgId !== null) {
        return `event_${eventName}_msg_${msgId}${convId ? `_conv_${convId}` : ''}`;
      }
    }

    if (eventName === 'conversation_status_changed') {
      const convId = conversation?.id || record.id;
      const status = conversation?.status || record.status;
      if (convId !== undefined && convId !== null) {
        return `event_${eventName}_conv_${convId}_status_${status || 'unknown'}`;
      }
    }

    if (eventName.includes('contact')) {
      const contact = (record.contact || record.sender || record.data) as Record<string, unknown> | undefined;
      const contactId = contact?.id || record.id;
      if (contactId !== undefined && contactId !== null) {
        return `event_${eventName}_contact_${contactId}`;
      }
    }

    if (eventName && record.id !== undefined && record.id !== null) {
      return `event_${eventName}_id_${record.id}`;
    }
  }

  // Canonical SHA-256 do JSON serializado como fallback seguro
  const serialized = typeof event === 'string' ? event : JSON.stringify(event || {});
  const hash = crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 32);
  return `${fallbackPrefix}_hash_${hash}`;
}

export class ChatwootInboxService {
  /**
   * Registra o evento no inbox de forma atômica no banco de dados.
   * Se o evento já existir para a organização, retorna isDuplicate = true e o resultado cacheado se houver.
   */
  async registerEvent(
    supabase: SupabaseClient,
    params: {
      organizacaoId: string;
      conexaoId?: string | null;
      userId?: string | null;
      inboxId?: number | null;
      idempotencyKey: string;
      eventType: string;
      payload: unknown;
    }
  ): Promise<RegisterChatwootInboxResult> {
    const { data, error } = await supabase.rpc('registrar_evento_inbox_chatwoot', {
      p_organizacao_id: params.organizacaoId,
      p_conexao_id: params.conexaoId || null,
      p_user_id: params.userId || null,
      p_inbox_id: params.inboxId || null,
      p_idempotency_key: params.idempotencyKey,
      p_event_type: params.eventType,
      p_payload: (params.payload && typeof params.payload === 'object') ? params.payload : { raw: params.payload },
    });

    if (error) {
      throw new Error(`Falha ao registrar evento no inbox Chatwoot: ${error.message}`);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error('Nenhum retorno recebido da função de registro de inbox Chatwoot.');
    }

    return {
      eventoId: row.evento_id,
      status: row.status,
      isDuplicate: Boolean(row.is_duplicate),
      cachedResponse: row.cached_response || null,
    };
  }

  /**
   * Conclui o evento no inbox como processado com sucesso, salvando a resposta cacheada.
   */
  async markProcessed(
    supabase: SupabaseClient,
    eventoId: string,
    responseBody: Record<string, unknown>
  ): Promise<void> {
    const { error } = await supabase.rpc('concluir_evento_inbox_chatwoot', {
      p_evento_id: eventoId,
      p_status: 'processed',
      p_response_body: responseBody,
      p_error: null,
    });

    if (error) {
      console.error('❌ Falha ao marcar evento Chatwoot como processed:', error.message);
    }
  }

  /**
   * Conclui o evento no inbox como com falha, preservando o erro redigido contra vazamento de segredos.
   */
  async markFailed(
    supabase: SupabaseClient,
    eventoId: string,
    error: unknown
  ): Promise<void> {
    let sanitizedMessage = 'Erro desconhecido durante processamento de webhook Chatwoot';
    if (error instanceof Error) {
      sanitizedMessage = error.message;
    } else if (typeof error === 'string') {
      sanitizedMessage = error;
    }

    // Redigir qualquer token, chave ou dado sensível que possa constar na mensagem de erro
    const redactedDiagnosis = typeof redactSensitiveData(sanitizedMessage) === 'string'
      ? (redactSensitiveData(sanitizedMessage) as string)
      : sanitizedMessage;

    const { error: dbError } = await supabase.rpc('concluir_evento_inbox_chatwoot', {
      p_evento_id: eventoId,
      p_status: 'failed',
      p_response_body: null,
      p_error: redactedDiagnosis,
    });

    if (dbError) {
      console.error('❌ Falha ao marcar evento Chatwoot como failed:', dbError.message);
    }
  }

  /**
   * Prepara um evento no inbox para replay seguro, restaurando o estado e retornando o payload.
   */
  async prepareReplay(
    supabase: SupabaseClient,
    eventoId: string
  ): Promise<{
    eventoId: string;
    organizacaoId: string;
    conexaoId?: string | null;
    userId?: string | null;
    inboxId?: number | null;
    eventType: string;
    payload: Record<string, unknown>;
  } | null> {
    const { data, error } = await supabase.rpc('preparar_replay_evento_inbox_chatwoot', {
      p_evento_id: eventoId,
    });

    if (error || !data) {
      console.error('❌ Falha ao preparar replay de evento Chatwoot:', error?.message);
      return null;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    return {
      eventoId: row.evento_id,
      organizacaoId: row.organizacao_id,
      conexaoId: row.conexao_id,
      userId: row.user_id,
      inboxId: row.inbox_id,
      eventType: row.event_type,
      payload: row.payload,
    };
  }
}

export const chatwootInboxService = new ChatwootInboxService();
