import { SupabaseClient } from '@supabase/supabase-js';

export type OutboxDestination = 'chatwoot' | 'bling' | 'webhook_externo';

export type OutboxStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed_transient'
  | 'dead_letter';

export type ErrorCategory =
  | 'transient'
  | 'permanent'
  | 'rate_limit'
  | 'auth_expired';

export interface OutboxEventRecord {
  id: string;
  organizacao_id: string;
  conexao_id?: string | null;
  user_id?: string | null;
  idempotency_key: string;
  destination: OutboxDestination;
  event_type: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error?: string | null;
  last_error_category?: ErrorCategory | null;
  response_body?: Record<string, unknown> | null;
  sent_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterOutboxResult {
  eventoId: string;
  status: OutboxStatus;
  isDuplicate: boolean;
}

export interface ClassifiedError {
  category: ErrorCategory;
  isTransient: boolean;
  message: string;
}

export interface IntegrationHealthSummary {
  id: string;
  provedor: string;
  nome: string;
  status: string;
  health_status: 'healthy' | 'degraded' | 'disconnected' | 'error';
  last_health_check_at: string | null;
  last_health_error: string | null;
}

export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9-_=.]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:secret_key|api_key|secret|token|password|client_secret|key)=[^\s&]*/gi, (match) => {
      const prefix = match.split('=')[0];
      return `${prefix}=[REDACTED]`;
    })
    .replace(/eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+/g, '[REDACTED_JWT]');
}

export function classifyError(error: unknown): ClassifiedError {
  const rawMsg = error instanceof Error ? error.message : String(error);
  const message = sanitizeErrorMessage(rawMsg);
  const lower = message.toLowerCase();

  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
    return { category: 'rate_limit', isTransient: true, message };
  }

  if (
    lower.includes('invalid_grant') ||
    lower.includes('token expirado') ||
    lower.includes('unauthorized') ||
    lower.includes('401')
  ) {
    return { category: 'auth_expired', isTransient: false, message };
  }

  if (
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('gateway') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('network error')
  ) {
    return { category: 'transient', isTransient: true, message };
  }

  return { category: 'permanent', isTransient: false, message };
}

export function calculateBackoffSeconds(
  attempts: number,
  baseSeconds = 10,
  maxSeconds = 3600,
): number {
  return Math.min(baseSeconds * Math.pow(2, attempts), maxSeconds);
}

export class OutboxService {
  async enqueue(
    supabase: SupabaseClient,
    params: {
      organizacaoId: string;
      conexaoId?: string | null;
      userId?: string | null;
      idempotencyKey: string;
      destination: OutboxDestination;
      eventType: string;
      payload: unknown;
      maxAttempts?: number;
    },
  ): Promise<RegisterOutboxResult> {
    const { data, error } = await supabase.rpc('registrar_evento_outbox', {
      p_organizacao_id: params.organizacaoId,
      p_conexao_id: params.conexaoId || null,
      p_user_id: params.userId || null,
      p_idempotency_key: params.idempotencyKey,
      p_destination: params.destination,
      p_event_type: params.eventType,
      p_payload:
        params.payload && typeof params.payload === 'object'
          ? params.payload
          : { raw: params.payload },
      p_max_attempts: params.maxAttempts ?? 5,
    });

    if (error) {
      throw new Error(`Falha ao registrar evento no outbox: ${error.message}`);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error('RPC registrar_evento_outbox não retornou dados.');
    }

    return {
      eventoId: row.evento_id,
      status: row.status,
      isDuplicate: Boolean(row.is_duplicate),
    };
  }

  async claimBatch(
    supabase: SupabaseClient,
    limit = 20,
  ): Promise<OutboxEventRecord[]> {
    const { data, error } = await supabase.rpc('reivindicar_lote_outbox', {
      p_limit: limit,
    });

    if (error) {
      throw new Error(`Falha ao reivindicar lote do outbox: ${error.message}`);
    }

    return (data || []) as OutboxEventRecord[];
  }

  async markSent(
    supabase: SupabaseClient,
    eventoId: string,
    responseBody?: Record<string, unknown> | null,
  ): Promise<void> {
    const { error } = await supabase.rpc('concluir_evento_outbox', {
      p_evento_id: eventoId,
      p_status: 'sent',
      p_response_body: responseBody || null,
      p_error: null,
      p_error_category: null,
      p_retry_delay_sec: 0,
    });

    if (error) {
      console.error('❌ outbox markSent falhou:', error.message);
    }
  }

  async markFailed(
    supabase: SupabaseClient,
    eventoId: string,
    error: unknown,
    currentAttempts = 0,
  ): Promise<void> {
    const classified = classifyError(error);
    const retryDelay = calculateBackoffSeconds(currentAttempts);
    const status = classified.isTransient ? 'failed_transient' : 'dead_letter';

    const { error: rpcError } = await supabase.rpc('concluir_evento_outbox', {
      p_evento_id: eventoId,
      p_status: status,
      p_response_body: null,
      p_error: classified.message,
      p_error_category: classified.category,
      p_retry_delay_sec: retryDelay,
    });

    if (rpcError) {
      console.error('❌ outbox markFailed falhou:', rpcError.message);
    }
  }

  async getIntegrationsHealth(
    supabase: SupabaseClient,
    organizacaoId: string,
  ): Promise<IntegrationHealthSummary[]> {
    const { data, error } = await supabase
      .from('conexoes_integracao')
      .select('id, provedor, nome, status, health_status, last_health_check_at, last_health_error')
      .eq('organizacao_id', organizacaoId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Falha ao consultar saúde das integrações: ${error.message}`);
    }

    return (data || []).map((row) => ({
      id: row.id,
      provedor: row.provedor,
      nome: row.nome,
      status: row.status,
      health_status: row.health_status,
      last_health_check_at: row.last_health_check_at,
      last_health_error: row.last_health_error ? sanitizeErrorMessage(row.last_health_error) : null,
    }));
  }

  async updateConnectionHealth(
    supabase: SupabaseClient,
    conexaoId: string,
    healthStatus: 'healthy' | 'degraded' | 'disconnected' | 'error',
    error?: string,
  ): Promise<void> {
    const sanitizedError = error ? sanitizeErrorMessage(error) : null;
    const { error: rpcError } = await supabase.rpc('atualizar_saude_conexao', {
      p_conexao_id: conexaoId,
      p_health_status: healthStatus,
      p_error: sanitizedError,
    });

    if (rpcError) {
      console.warn('⚠️ falha ao atualizar saúde da conexão:', rpcError.message);
    }
  }
}

export const outboxService = new OutboxService();
