import { SupabaseClient } from '@supabase/supabase-js';
import { redactSensitiveData } from '@/lib/observability/logger';

export interface AuditEventInput {
  organizacaoId?: string | null;
  actorId?: string | null;
  acao: string;
  recurso: string;
  recursoId?: string | null;
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: string;
  organizacaoId: string | null;
  actorId: string | null;
  acao: string;
  recurso: string;
  recursoId: string | null;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ListAuditEventsQuery {
  organizacaoId: string;
  limit?: number;
  offset?: number;
  acao?: string;
  actorId?: string;
}

/**
 * Registra um evento de auditoria imutável com sanitização automática de segredos.
 */
export async function recordAuditEvent(
  supabase: SupabaseClient,
  input: AuditEventInput,
): Promise<string> {
  const sanitizedMetadata = input.metadata
    ? (redactSensitiveData(input.metadata) as Record<string, unknown>)
    : {};

  const { data, error } = await supabase.rpc('registrar_evento_auditoria', {
    p_org_id: input.organizacaoId ?? null,
    p_actor_id: input.actorId ?? null,
    p_acao: input.acao,
    p_recurso: input.recurso,
    p_recurso_id: input.recursoId ?? null,
    p_correlation_id: input.correlationId ?? null,
    p_ip_address: input.ipAddress ?? null,
    p_user_agent: input.userAgent ?? null,
    p_metadata: sanitizedMetadata,
  });

  if (error) {
    throw new Error(`Falha ao registrar evento de auditoria: ${error.message}`);
  }

  return data as string;
}

/**
 * Lista eventos de auditoria para uma organização com paginação e filtros.
 */
export async function listAuditEvents(
  supabase: SupabaseClient,
  query: ListAuditEventsQuery,
): Promise<{ events: AuditEventRecord[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  let builder = supabase
    .from('eventos_auditoria_sistema')
    .select('id, organizacao_id, actor_id, acao, recurso, recurso_id, correlation_id, ip_address, user_agent, metadata, created_at', { count: 'exact' })
    .eq('organizacao_id', query.organizacaoId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (query.acao) {
    builder = builder.eq('acao', query.acao);
  }
  if (query.actorId) {
    builder = builder.eq('actor_id', query.actorId);
  }

  const { data, count, error } = await builder;

  if (error) {
    throw new Error(`Falha ao consultar trilha de auditoria: ${error.message}`);
  }

  const events: AuditEventRecord[] = (data || []).map((row) => ({
    id: row.id,
    organizacaoId: row.organizacao_id,
    actorId: row.actor_id,
    acao: row.acao,
    recurso: row.recurso,
    recursoId: row.recurso_id,
    correlationId: row.correlation_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  }));

  return {
    events,
    total: count ?? events.length,
  };
}
