import { SupabaseClient } from '@supabase/supabase-js';
import { redactSensitiveData } from '@/lib/observability/logger';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { validateAuditEventMetadata } from '@/lib/observability/auditEventCatalog';

/**
 * Identidade de sistema para eventos sem ator humano (webhook verificado, job/worker,
 * reaper, migration/readiness). Nunca é escolhida por input do usuário — é o próprio
 * código server-only que declara sua origem ao chamar `recordSystemAuditEvent`.
 */
export type SystemAuditSource = 'webhook_processor' | 'worker' | 'reaper' | 'migration' | 'readiness';

export interface SystemAuditEventInput {
  source: SystemAuditSource;
  /** Organização afetada, ou `null` para evento de plataforma sem organização específica. */
  organizationId: string | null;
  acao: string;
  recurso: string;
  recursoId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditEventInput {
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
  limit?: number;
  offset?: number;
  acao?: string;
  actorId?: string;
  /** Tipo de autor: humano, resposta automática da IA, ou o resto sem humano. */
  origem?: 'pessoas' | 'bot' | 'sistema';
}

/** Valida `acao`/`metadata` contra o catálogo versionado ou lança um erro tipado. */
function assertValidCatalogEvent(acao: string, metadata: Record<string, unknown>): void {
  const validation = validateAuditEventMetadata(acao, metadata);
  if (validation._tag === 'UnknownEvent') {
    throw new Error(
      `Evento de auditoria "${acao}" não pertence ao catálogo versionado (auditEventCatalog.ts)`,
    );
  }
  if (validation._tag === 'ForbiddenField') {
    throw new Error(`Campo "${validation.field}" é proibido no metadata do evento "${acao}"`);
  }
}

interface RegistrarEventoAuditoriaParams {
  p_org_id: string | null;
  p_actor_id: string | null;
  p_acao: string;
  p_recurso: string;
  p_recurso_id: string | null;
  p_correlation_id: string | null;
  p_ip_address: string | null;
  p_user_agent: string | null;
  p_metadata: Record<string, unknown>;
}

/** Chama a RPC de registro e traduz erro do Supabase em erro tipado com contexto. */
async function callRegistrarEventoAuditoria(
  supabase: SupabaseClient,
  params: RegistrarEventoAuditoriaParams,
  errorContext: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('registrar_evento_auditoria', params);
  if (error) {
    throw new Error(`Falha ao registrar evento de auditoria (${errorContext}): ${error.message}`);
  }
  return data as string;
}

/**
 * Registra um evento de auditoria imutável com sanitização automática de segredos.
 *
 * `supabase` precisa ser um cliente `service_role` (ex.: `supabaseServer`) — a RPC
 * `registrar_evento_auditoria` (migration 52) só concede `EXECUTE` a `service_role`,
 * assim como as demais RPCs de infraestrutura (inbox/outbox/job). O ator/organização já
 * vêm verificados de `scope` (`VerifiedOrganizationScope`), nunca de input do navegador;
 * a RPC ainda revalida internamente que esse par é uma membership real, como última
 * linha de defesa contra um bug futuro na camada de aplicação.
 */
export async function recordAuditEvent(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  input: AuditEventInput,
): Promise<string> {
  assertValidCatalogEvent(input.acao, input.metadata ?? {});

  const sanitizedMetadata = input.metadata
    ? (redactSensitiveData(input.metadata) as Record<string, unknown>)
    : {};

  return callRegistrarEventoAuditoria(
    supabase,
    {
      p_org_id: scope.organizationId,
      p_actor_id: scope.actorId,
      p_acao: input.acao,
      p_recurso: input.recurso,
      p_recurso_id: input.recursoId ?? null,
      p_correlation_id: input.correlationId ?? null,
      p_ip_address: input.ipAddress ?? null,
      p_user_agent: input.userAgent ?? null,
      p_metadata: sanitizedMetadata,
    },
    'ator verificado',
  );
}

/**
 * Registra um evento de auditoria produzido por identidade de sistema verificada
 * (webhook já autenticado por assinatura, worker/job durável, reaper de lease, migration
 * ou readiness check) — nunca por escolha do usuário. Não recebe `actorId`: o ator é
 * sempre `null` (evento sem ator humano), o que a RPC `registrar_evento_auditoria`
 * apenas aceita quando o chamador é `service_role`.
 */
export async function recordSystemAuditEvent(
  supabase: SupabaseClient,
  input: SystemAuditEventInput,
): Promise<string> {
  assertValidCatalogEvent(input.acao, input.metadata ?? {});

  const sanitizedMetadata = redactSensitiveData({
    ...input.metadata,
    _source: input.source,
  }) as Record<string, unknown>;

  return callRegistrarEventoAuditoria(
    supabase,
    {
      p_org_id: input.organizationId,
      p_actor_id: null,
      p_acao: input.acao,
      p_recurso: input.recurso,
      p_recurso_id: input.recursoId ?? null,
      p_correlation_id: input.correlationId ?? null,
      p_ip_address: null,
      p_user_agent: null,
      p_metadata: sanitizedMetadata,
    },
    'identidade de sistema',
  );
}

/**
 * Lista eventos de auditoria para uma organização com paginação e filtros.
 */
export async function listAuditEvents(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  query: ListAuditEventsQuery,
): Promise<{ events: AuditEventRecord[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  let builder = supabase
    .from('eventos_auditoria_sistema')
    .select('id, organizacao_id, actor_id, acao, recurso, recurso_id, correlation_id, ip_address, user_agent, metadata, created_at', { count: 'exact' })
    .eq('organizacao_id', scope.organizationId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (query.acao) {
    builder = builder.eq('acao', query.acao);
  }
  if (query.actorId) {
    builder = builder.eq('actor_id', query.actorId);
  }
  // A IA grava `origem: 'ia'` sem ator humano (migration 95).
  if (query.origem === 'pessoas') {
    builder = builder.not('actor_id', 'is', null);
  } else if (query.origem === 'bot') {
    builder = builder.is('actor_id', null).eq('metadata->>origem', 'ia');
  } else if (query.origem === 'sistema') {
    builder = builder.is('actor_id', null).or('metadata->>origem.is.null,metadata->>origem.neq.ia');
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
