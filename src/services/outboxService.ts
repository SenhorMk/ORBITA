import { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

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
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  correlation_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape returned by `reivindicar_lote_outbox` (claim RPC) — snake_case
 * as returned by Postgres, distinct from `OutboxEventRecord` because the
 * claim RPC returns a narrower projection (no `idempotency_key`/`user_id`). */
export interface ClaimedOutboxEvent {
  evento_id: string;
  organizacao_id: string;
  conexao_id: string | null;
  destination: OutboxDestination;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  lease_owner: string;
  lease_expires_at: string;
  correlation_id: string | null;
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
  private async assertRecordScope(
    supabase: SupabaseClient,
    table: 'eventos_outbox' | 'conexoes_integracao',
    scope: VerifiedOrganizationScope,
    id: string,
  ): Promise<void> {
    const { data, error } = await supabase
      .from(table)
      .select('id')
      .eq('id', id)
      .eq('organizacao_id', scope.organizationId)
      .maybeSingle();
    if (error) throw new Error(`Falha ao validar escopo de ${table}: ${error.message}`);
    if (!data) throw new Error(`${table} fora do escopo organizacional verificado.`);
  }
  async enqueue(
    supabase: SupabaseClient,
    scope: VerifiedOrganizationScope,
    params: {
      conexaoId?: string | null;
      idempotencyKey: string;
      destination: OutboxDestination;
      eventType: string;
      payload: unknown;
      maxAttempts?: number;
    },
  ): Promise<RegisterOutboxResult> {
    const { data, error } = await supabase.rpc('registrar_evento_outbox', {
      p_organizacao_id: scope.organizationId,
      p_conexao_id: params.conexaoId || null,
      p_user_id: scope.actorId,
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

  /**
   * Reivindica um lote de eventos pendentes/retryable para este worker.
   * `workerId` identifica o dono do lease (não é autoridade de tenant — só
   * serve para provar posse na conclusão e para observabilidade). Cada
   * evento retornado carrega `lease_owner`/`lease_expires_at`: nenhum outro
   * worker consegue reivindicar o mesmo evento enquanto o lease for válido
   * (imposto no banco por `FOR UPDATE SKIP LOCKED`, não em memória).
   */
  async claimBatch(
    supabase: SupabaseClient,
    workerId: string,
    limit = 20,
    leaseTtlSeconds = 300,
  ): Promise<ClaimedOutboxEvent[]> {
    if (!workerId || workerId.trim().length === 0) {
      throw new Error('workerId é obrigatório para reivindicar lote do outbox.');
    }
    const { data, error } = await supabase.rpc('reivindicar_lote_outbox', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_ttl_sec: leaseTtlSeconds,
    });

    if (error) {
      throw new Error(`Falha ao reivindicar lote do outbox: ${error.message}`);
    }

    return (data || []) as ClaimedOutboxEvent[];
  }

  /**
   * Marca um evento como enviado. Exige `workerId` = dono do lease vigente;
   * se o lease expirou (ou pertence a outro worker), o RPC retorna `false`
   * sem aplicar nenhuma mudança — impede que um worker "zumbi" duplique o
   * efeito de outro worker que já retomou o mesmo evento.
   */
  async markSent(
    supabase: SupabaseClient,
    scope: VerifiedOrganizationScope,
    workerId: string,
    eventoId: string,
    responseBody?: Record<string, unknown> | null,
  ): Promise<boolean> {
    await this.assertRecordScope(supabase, 'eventos_outbox', scope, eventoId);
    const { data, error } = await supabase.rpc('concluir_evento_outbox', {
      p_evento_id: eventoId,
      p_worker_id: workerId,
      p_status: 'sent',
      p_response_body: responseBody || null,
      p_error: null,
      p_error_category: null,
      p_retry_delay_sec: 0,
    });

    if (error) {
      console.error('❌ outbox markSent falhou:', error.message);
      return false;
    }
    return data === true;
  }

  async markFailed(
    supabase: SupabaseClient,
    scope: VerifiedOrganizationScope,
    workerId: string,
    eventoId: string,
    error: unknown,
    currentAttempts = 0,
  ): Promise<boolean> {
    const classified = classifyError(error);
    const retryDelay = calculateBackoffSeconds(currentAttempts);
    const status = classified.isTransient ? 'failed_transient' : 'dead_letter';

    await this.assertRecordScope(supabase, 'eventos_outbox', scope, eventoId);
    const { data, error: rpcError } = await supabase.rpc('concluir_evento_outbox', {
      p_evento_id: eventoId,
      p_worker_id: workerId,
      p_status: status,
      p_response_body: null,
      p_error: classified.message,
      p_error_category: classified.category,
      p_retry_delay_sec: retryDelay,
    });

    if (rpcError) {
      console.error('❌ outbox markFailed falhou:', rpcError.message);
      return false;
    }
    return data === true;
  }

  /**
   * Variantes usadas pelo worker de outbox em lote (`outboxWorker`), que
   * opera como `service_role` sobre eventos de múltiplas organizações numa
   * única chamada — não existe um único ator/sessão verificada para todo o
   * lote. A autoridade explícita aqui não é `VerifiedOrganizationScope`: é a
   * posse do lease (`workerId` conferido dentro de `concluir_evento_outbox`,
   * que só aceita o dono do lease vigente) somada ao fato de `eventoId` já
   * ter sido resolvido para uma organização real pelo próprio RPC de claim
   * (nunca um id vindo de input não verificado). Fora do worker, prefira
   * `markSent`/`markFailed`, que exigem escopo organizacional verificado.
   */
  async completeClaimedSent(
    supabase: SupabaseClient,
    workerId: string,
    eventoId: string,
    responseBody?: Record<string, unknown> | null,
  ): Promise<boolean> {
    const { data, error } = await supabase.rpc('concluir_evento_outbox', {
      p_evento_id: eventoId,
      p_worker_id: workerId,
      p_status: 'sent',
      p_response_body: responseBody || null,
      p_error: null,
      p_error_category: null,
      p_retry_delay_sec: 0,
    });
    if (error) {
      console.error('❌ outbox worker: falha ao marcar sent:', error.message);
      return false;
    }
    return data === true;
  }

  async completeClaimedFailed(
    supabase: SupabaseClient,
    workerId: string,
    eventoId: string,
    error: unknown,
    currentAttempts = 0,
  ): Promise<boolean> {
    const classified = classifyError(error);
    const retryDelay = calculateBackoffSeconds(currentAttempts);
    const status = classified.isTransient ? 'failed_transient' : 'dead_letter';

    const { data, error: rpcError } = await supabase.rpc('concluir_evento_outbox', {
      p_evento_id: eventoId,
      p_worker_id: workerId,
      p_status: status,
      p_response_body: null,
      p_error: classified.message,
      p_error_category: classified.category,
      p_retry_delay_sec: retryDelay,
    });
    if (rpcError) {
      console.error('❌ outbox worker: falha ao marcar failed:', rpcError.message);
      return false;
    }
    return data === true;
  }

  /**
   * Recuperação de crash: devolve eventos travados em `processing` com lease
   * expirado para `failed_transient`/`dead_letter` (respeitando
   * `max_attempts`). Deve ser chamada antes de reivindicar um novo lote —
   * mesmo padrão de `releaseExpiredLeases` já usado em `syncJobRepository`.
   */
  async releaseExpiredLeases(
    supabase: SupabaseClient,
  ): Promise<Array<{ eventoId: string; novoStatus: OutboxStatus }>> {
    const { data, error } = await supabase.rpc('liberar_leases_expirados_outbox');

    if (error) {
      console.warn('⚠️ outbox: falha ao liberar leases expirados:', error.message);
      return [];
    }

    return ((data || []) as Array<{ evento_id: string; novo_status: OutboxStatus }>).map((row) => ({
      eventoId: row.evento_id,
      novoStatus: row.novo_status,
    }));
  }

  async getIntegrationsHealth(
    supabase: SupabaseClient,
    scope: VerifiedOrganizationScope,
  ): Promise<IntegrationHealthSummary[]> {
    const { data, error } = await supabase
      .from('conexoes_integracao')
      .select('id, provedor, nome, status, health_status, last_health_check_at, last_health_error')
      .eq('organizacao_id', scope.organizationId)
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
    scope: VerifiedOrganizationScope,
    conexaoId: string,
    healthStatus: 'healthy' | 'degraded' | 'disconnected' | 'error',
    error?: string,
  ): Promise<void> {
    await this.assertRecordScope(supabase, 'conexoes_integracao', scope, conexaoId);
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
