/**
 * entitlementLifecycleRepository.ts
 * Repository escopado por organização que carrega plano, assinatura,
 * status de ciclo de vida e uso atual de recursos limitados.
 *
 * Toda query aqui repete o predicado `organizacao_id = orgId` mesmo usando o
 * `supabaseServer` (service role bypassa RLS — o escopo precisa ser reafirmado em código).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SubscriptionLifecycleState } from '@/domain/entitlements/subscriptionLifecycle';
import type {
  EntitlementLimitsSnapshot,
  ResourceUsageSnapshot,
} from '@/domain/entitlements/entitlementPolicy';

export interface OrganizationEntitlementSnapshot {
  readonly state: SubscriptionLifecycleState;
  readonly limits: EntitlementLimitsSnapshot;
  readonly usage: ResourceUsageSnapshot;
  readonly planoSlug: string;
}

type DbOrganizacaoStatus = 'active' | 'suspended' | 'pending_deletion' | 'deleted';
type DbAssinaturaStatus = 'trial' | 'active' | 'past_due' | 'canceled' | 'incomplete';

/**
 * Mapeia o par (status de ciclo de vida da organização, status de cobrança da
 * assinatura) para o estado canônico único do domínio.
 *
 * Regra: o status operacional da organização (suspenso/pending_deletion/deleted)
 * tem prioridade sobre o status de cobrança — uma organização suspensa por
 * violação de termos continua bloqueada mesmo que a fatura esteja em dia.
 * `deleted` (estado terminal pós-anonimização, fora dos 6 estados da máquina de
 * ciclo de vida) é tratado como `pending_deletion` para nunca liberar mutação por
 * fallback. `incomplete` (checkout iniciado e não confirmado) é tratado como
 * `past_due`: mesma política de bloqueio de mutação por prudência de cobrança.
 */
export function mapPersistedStatusToLifecycleState(
  organizacaoStatus: DbOrganizacaoStatus,
  assinaturaStatus: DbAssinaturaStatus,
  since: string,
  motivoSuspensao?: string | null,
  exclusaoAgendadaPara?: string | null,
): SubscriptionLifecycleState {
  if (organizacaoStatus === 'suspended') {
    return { kind: 'suspended', since, reason: motivoSuspensao ?? 'nao especificado' };
  }
  if (organizacaoStatus === 'pending_deletion' || organizacaoStatus === 'deleted') {
    return { kind: 'pending_deletion', since, scheduledFor: exclusaoAgendadaPara ?? since };
  }

  switch (assinaturaStatus) {
    case 'trial':
      return { kind: 'trial', since };
    case 'active':
      return { kind: 'active', since };
    case 'past_due':
    case 'incomplete':
      return { kind: 'past_due', since };
    case 'canceled':
      return { kind: 'cancelled', since };
    default:
      // SAFETY: valor inesperado do banco é tratado como bloqueado (fail closed),
      // nunca como "active" por fallback.
      return { kind: 'pending_deletion', since, scheduledFor: since };
  }
}

export class OrganizationNotFoundError extends Error {
  readonly code = 'ORGANIZATION_NOT_FOUND';
  constructor(orgId: string) {
    super(`Organizacao ${orgId} nao encontrada`);
    this.name = 'OrganizationNotFoundError';
  }
}

/**
 * Carrega o snapshot completo de entitlement/ciclo de vida de uma organização,
 * escopado explicitamente por `orgId` verificado (nunca aceito do cliente).
 */
export async function loadOrganizationEntitlementSnapshot(
  supabase: SupabaseClient,
  orgId: string,
): Promise<OrganizationEntitlementSnapshot> {
  const { data: org, error: orgErr } = await supabase
    .from('organizacoes')
    .select('id, status, suspenso_em, motivo_suspensao, exclusao_agendada_para, updated_at')
    .eq('id', orgId)
    .single();

  if (orgErr || !org) {
    throw new OrganizationNotFoundError(orgId);
  }

  const { data: entitlements, error: entErr } = await supabase.rpc('obter_entitlements_organizacao', {
    p_org_id: orgId,
  });

  if (entErr || !entitlements) {
    throw new Error(`Falha ao carregar entitlements da organizacao ${orgId}: ${entErr?.message ?? 'sem dados'}`);
  }

  const [{ count: membrosCount, error: membrosErr }, { count: blingCount, error: blingErr }, { count: chatwootCount, error: chatwootErr }] =
    await Promise.all([
      supabase
        .from('membros_organizacao')
        .select('*', { count: 'exact', head: true })
        .eq('organizacao_id', orgId),
      supabase
        .from('conexoes_integracao')
        .select('*', { count: 'exact', head: true })
        .eq('organizacao_id', orgId)
        .eq('provedor', 'bling')
        .eq('status', 'ativa'),
      supabase
        .from('conexoes_integracao')
        .select('*', { count: 'exact', head: true })
        .eq('organizacao_id', orgId)
        .eq('provedor', 'chatwoot')
        .eq('status', 'ativa'),
    ]);

  if (membrosErr || blingErr || chatwootErr) {
    throw new Error(
      `Falha ao carregar uso de recursos da organizacao ${orgId}: ${
        membrosErr?.message ?? blingErr?.message ?? chatwootErr?.message
      }`,
    );
  }

  const since = (org.suspenso_em as string | null) ?? (org.updated_at as string);
  const state = mapPersistedStatusToLifecycleState(
    org.status as DbOrganizacaoStatus,
    entitlements.status as DbAssinaturaStatus,
    since,
    org.motivo_suspensao as string | null,
    org.exclusao_agendada_para as string | null,
  );

  return {
    state,
    planoSlug: entitlements.plano_slug as string,
    limits: {
      limite_membros: entitlements.limite_membros as number,
      limite_conexoes_bling: entitlements.limite_conexoes_bling as number,
      limite_conexoes_chatwoot: entitlements.limite_conexoes_chatwoot as number,
      recursos: (entitlements.recursos as Record<string, boolean>) ?? {},
    },
    usage: {
      membros: membrosCount ?? 0,
      conexoes_bling: blingCount ?? 0,
      conexoes_chatwoot: chatwootCount ?? 0,
    },
  };
}
