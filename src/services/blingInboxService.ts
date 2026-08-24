import crypto from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { redactSensitiveData } from '../lib/integrations/credentialsVault';

export interface BlingInboxEventRecord {
  id: string;
  organizacao_id: string;
  conexao_id?: string | null;
  user_id?: string | null;
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

export interface RegisterInboxResult {
  eventoId: string;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'ignored';
  isDuplicate: boolean;
  cachedResponse?: Record<string, unknown> | null;
}

/**
 * Computa uma chave determinística de idempotência para o evento Bling.
 * Se o evento contiver eventId/id + entidade, usa a tupla estruturada;
 * caso contrário, calcula o SHA-256 canônico do payload.
 */
export function generateBlingIdempotencyKey(event: unknown, fallbackPrefix = 'bling'): string {
  if (typeof event === 'object' && event !== null) {
    const record = event as Record<string, unknown>;
    const entity = String(record.event || record.entity || record.entidade || record.topic || record.type || '').toLowerCase().trim();
    const eventData = (record.data || record.retorno || record) as Record<string, unknown>;

    const eventId = record.eventId || record.id || eventData.id || eventData.idProduto || eventData.bling_id;
    const action = record.action || record.operacao || record.evento;

    if (entity && eventId) {
      return `${entity}_${eventId}${action ? `_${action}` : ''}`;
    }
  }

  // Canonical SHA-256 do JSON serializado
  const serialized = typeof event === 'string' ? event : JSON.stringify(event || {});
  const hash = crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 32);
  return `${fallbackPrefix}_hash_${hash}`;
}

export class BlingInboxService {
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
      idempotencyKey: string;
      eventType: string;
      payload: unknown;
    }
  ): Promise<RegisterInboxResult> {
    const { data, error } = await supabase.rpc('registrar_evento_inbox_bling', {
      p_organizacao_id: params.organizacaoId,
      p_conexao_id: params.conexaoId || null,
      p_user_id: params.userId || null,
      p_idempotency_key: params.idempotencyKey,
      p_event_type: params.eventType,
      p_payload: (params.payload && typeof params.payload === 'object') ? params.payload : { raw: params.payload },
    });

    if (error) {
      throw new Error(`Falha ao registrar evento no inbox Bling: ${error.message}`);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error('Nenhum retorno recebido da função de registro de inbox Bling.');
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
    const { error } = await supabase.rpc('concluir_evento_inbox_bling', {
      p_evento_id: eventoId,
      p_status: 'processed',
      p_response_body: responseBody,
      p_error: null,
    });

    if (error) {
      console.error('❌ Falha ao marcar evento Bling como processed:', error.message);
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
    let sanitizedMessage = 'Erro desconhecido durante processamento de webhook';
    if (error instanceof Error) {
      sanitizedMessage = error.message;
    } else if (typeof error === 'string') {
      sanitizedMessage = error;
    }

    // Redigir qualquer token, chave ou dado sensível que possa constar na mensagem de erro
    const redactedDiagnosis = typeof redactSensitiveData(sanitizedMessage) === 'string'
      ? (redactSensitiveData(sanitizedMessage) as string)
      : sanitizedMessage;

    const { error: dbError } = await supabase.rpc('concluir_evento_inbox_bling', {
      p_evento_id: eventoId,
      p_status: 'failed',
      p_response_body: null,
      p_error: redactedDiagnosis,
    });

    if (dbError) {
      console.error('❌ Falha ao marcar evento Bling como failed:', dbError.message);
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
    eventType: string;
    payload: Record<string, unknown>;
  } | null> {
    const { data, error } = await supabase.rpc('preparar_replay_evento_inbox_bling', {
      p_evento_id: eventoId,
    });

    if (error || !data) {
      console.error('❌ Falha ao preparar replay de evento Bling:', error?.message);
      return null;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    return {
      eventoId: row.evento_id,
      organizacaoId: row.organizacao_id,
      conexaoId: row.conexao_id,
      userId: row.user_id,
      eventType: row.event_type,
      payload: row.payload,
    };
  }
}

export const blingInboxService = new BlingInboxService();
