import { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { descreverErro } from '@/lib/erroLegivel';
import type { DesfechoDoDespacho } from '@/services/outbox/desfechoDoEfeito';

export type OutboxDestination = 'chatwoot' | 'bling' | 'webhook_externo';

export type OutboxStatus =
  | 'pending'
  | 'processing'
  | 'in_flight'
  | 'sent'
  | 'failed_transient'
  | 'dead_letter'
  | 'unknown';

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

/** Row shape returned by `reivindicar_tentativas_outbox` (claim RPC) — snake_case
 * as returned by Postgres, distinct from `OutboxEventRecord` because the
 * claim RPC returns a narrower projection (no `idempotency_key`/`user_id`).
 * `fencing_token` is the token of this claim: only it starts and concludes. */
const ClaimedOutboxEventSchema = z.object({
  evento_id: z.string().uuid(),
  organizacao_id: z.string().uuid(),
  conexao_id: z.string().uuid().nullable(),
  destination: z.enum(['chatwoot', 'bling', 'webhook_externo']),
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  lease_owner: z.string(),
  lease_expires_at: z.string(),
  correlation_id: z.string().nullable(),
  fencing_token: z.coerce.number().int().positive(),
});
export type ClaimedOutboxEvent = z.infer<typeof ClaimedOutboxEventSchema>;

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
  /**
   * Se as credenciais do aplicativo (passo 1) já estao gravadas para esta
   * conexao. Booleano de proposito: a tela precisa saber que o passo 1
   * aconteceu, e nem o `client_id` nem o `client_secret` podem sair daqui.
   *
   * Antes o painel dependia de estado local do React, que morria no reload —
   * entao ninguem, nem o usuario nem o suporte, conseguia dizer se o passo 1
   * tinha funcionado.
   */
  credenciais_configuradas: boolean;
}

/**
 * Deriva, sem revelar nada, se `metadata` ja carrega o `client_id` do
 * aplicativo do provedor. Só o booleano cruza a fronteira HTTP.
 */
export function hasConfiguredCredentials(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false;
  const clientId = (metadata as Record<string, unknown>).client_id;
  return typeof clientId === 'string' && clientId.trim().length > 0;
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

/**
 * Categoria e mensagem redigida de um erro, por texto. Serve para relatório e
 * saúde da conexão; NUNCA decide repetir um efeito da outbox — essa decisão é
 * do desfecho tipado do adapter (`desfechoDoEfeito.ts`).
 */
export function classifyError(error: unknown): ClassifiedError {
  const rawMsg = descreverErro(error);
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
    table: 'conexoes_integracao',
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
      if (error.code === '23505') throw new OutboxIntencaoDivergente();
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
   * `workerId` identifica o dono do lease (não é autoridade de tenant). Cada
   * evento volta com o `fencing_token` da posse, que o banco sobe a cada
   * reivindicação: só ele inicia o despacho e conclui. Exclusão mútua por
   * `FOR UPDATE SKIP LOCKED` no banco, não em memória.
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
    const { data, error } = await supabase.rpc('reivindicar_tentativas_outbox', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_ttl_sec: leaseTtlSeconds,
    });

    if (error) {
      throw new Error(`Falha ao reivindicar lote do outbox: ${error.message}`);
    }

    return ClaimedOutboxEventSchema.array().parse(data ?? []);
  }

  /**
   * Reivindica um evento da organização verificada (envio inline). Devolve o
   * fencing token da posse, ou `null` se o evento não estava na fila — por
   * exemplo, porque já está em voo ou desconhecido.
   */
  async claimOne(
    supabase: SupabaseClient,
    scope: VerifiedOrganizationScope,
    eventoId: string,
    workerId: string,
    leaseTtlSeconds = 60,
  ): Promise<number | null> {
    const { data, error } = await supabase.rpc('reivindicar_evento_outbox', {
      p_organizacao_id: scope.organizationId,
      p_evento_id: eventoId,
      p_worker_id: workerId,
      p_lease_ttl_sec: leaseTtlSeconds,
    });
    if (error) throw new Error(`Falha ao reivindicar evento do outbox: ${error.message}`);
    const linhas = z.array(z.object({ fencing_token: z.coerce.number().int().positive() })).parse(data ?? []);
    return linhas[0]?.fencing_token ?? null;
  }

  /**
   * Último passo antes da rede: grava `in_flight` e a tentativa. `false` quando
   * a posse não é mais deste token — o chamador não pode despachar.
   */
  async startDispatch(supabase: SupabaseClient, eventoId: string, workerId: string, fencingToken: number): Promise<boolean> {
    const { data, error } = await supabase.rpc('iniciar_despacho_outbox', {
      p_evento_id: eventoId,
      p_worker_id: workerId,
      p_fencing_token: fencingToken,
    });
    if (error) throw new Error(`Falha ao iniciar despacho do outbox: ${error.message}`);
    return data === true;
  }

  /**
   * Grava o desfecho por compare-and-set de dono, token e lease. Devolve o
   * status gravado, ou `null` quando a posse já não é deste token (lease
   * vencida, reaper, outro dono): nada muda e o efeito, se houve, fica para a
   * reconciliação. Erro de banco é lançado, nunca convertido em sucesso.
   */
  async concludeAttempt(
    supabase: SupabaseClient,
    posse: { readonly eventoId: string; readonly workerId: string; readonly fencingToken: number },
    desfecho: DesfechoDoDespacho,
  ): Promise<OutboxStatus | null> {
    const { data, error } = await supabase.rpc('concluir_tentativa_outbox', {
      p_evento_id: posse.eventoId,
      p_worker_id: posse.workerId,
      p_fencing_token: posse.fencingToken,
      ...parametrosDoDesfecho(desfecho),
    });
    if (error) throw new Error(`Falha ao concluir tentativa do outbox: ${error.message}`);
    return StatusConcluidoSchema.parse(data);
  }

  /**
   * Recuperação de crash: `processing` vencido nunca despachou e volta à fila;
   * `in_flight` vencido pode ter despachado e vira `unknown`. Deve ser chamada
   * antes de reivindicar um novo lote.
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
      .select('id, provedor, nome, status, health_status, last_health_check_at, last_health_error, metadata')
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
      credenciais_configuradas: hasConfiguredCredentials(row.metadata),
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

/** Mesma chave de idempotência com outra intenção: o banco recusa com 23505. */
export class OutboxIntencaoDivergente extends Error {
  constructor() {
    super('A chave de idempotência já pertence a outra intenção.');
    this.name = 'OutboxIntencaoDivergente';
  }
}

const STATUS = z.enum(['pending', 'processing', 'in_flight', 'sent', 'failed_transient', 'dead_letter', 'unknown']);
const StatusConcluidoSchema = STATUS.nullable();


/** Os parâmetros da conclusão para cada desfecho; nenhum campo é inventado. */
function parametrosDoDesfecho(desfecho: DesfechoDoDespacho) {
  switch (desfecho._tag) {
    case 'Confirmado':
      return { p_desfecho: 'confirmado', p_recibo_ref: desfecho.recibo, p_resposta: desfecho.resposta ?? null };
    case 'NaoEnviado':
      return {
        p_desfecho: 'nao_enviado',
        p_motivo: desfecho.prova,
        p_erro: sanitizeErrorMessage(desfecho.erro),
        p_categoria: 'transient',
        p_retry_delay_sec: desfecho.retryAfterSeconds ?? 10,
      };
    case 'Recusado':
      return {
        p_desfecho: 'recusado',
        p_motivo: desfecho.codigo,
        p_erro: sanitizeErrorMessage(desfecho.erro),
        p_categoria: desfecho.categoria,
      };
    case 'Desconhecido':
      return {
        p_desfecho: 'desconhecido',
        p_motivo: desfecho.motivo,
        p_erro: sanitizeErrorMessage(desfecho.erro),
        p_categoria: 'transient',
      };
  }
}

