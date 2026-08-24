import { SupabaseClient } from '@supabase/supabase-js';

export type OrganizationLifecycleStatus = 'active' | 'suspended' | 'pending_deletion' | 'deleted';

export interface OrganizationLifecycleState {
  status: OrganizationLifecycleStatus;
  suspensoEm: string | null;
  motivoSuspensao: string | null;
  exclusaoAgendadaPara: string | null;
  encerradoEm: string | null;
}

export class OrganizationInactiveError extends Error {
  readonly code = 'ORGANIZATION_INACTIVE';
  readonly status: OrganizationLifecycleStatus;

  constructor(status: OrganizationLifecycleStatus, message?: string) {
    super(message ?? `Organizacao inativa ou com operacoes restritas (status: ${status})`);
    this.name = 'OrganizationInactiveError';
    this.status = status;
  }
}

async function executeLifecycleStatusTransition(
  supabase: SupabaseClient,
  rpcName: 'suspender_organizacao' | 'reativar_organizacao' | 'cancelar_agendamento_encerramento',
  orgId: string,
  motivo?: string,
  authorId?: string,
): Promise<void> {
  const params: Record<string, unknown> = {
    p_org_id: orgId,
    p_autor_id: authorId ?? null,
  };
  if (motivo !== undefined) {
    params.p_motivo = motivo;
  }
  const { error } = await supabase.rpc(rpcName, params);
  if (error) {
    throw new Error(`Falha ao executar ${rpcName}: ${error.message}`);
  }
}

/**
 * Suspende uma organização (inadimplência ou violação de termos).
 */
export async function suspendOrganization(
  supabase: SupabaseClient,
  orgId: string,
  motivo: string,
  authorId?: string,
): Promise<void> {
  return executeLifecycleStatusTransition(supabase, 'suspender_organizacao', orgId, motivo, authorId);
}

/**
 * Reativa uma organização previamente suspensa.
 */
export async function reactivateOrganization(
  supabase: SupabaseClient,
  orgId: string,
  motivo: string,
  authorId?: string,
): Promise<void> {
  return executeLifecycleStatusTransition(supabase, 'reativar_organizacao', orgId, motivo, authorId);
}

/**
 * Agenda o encerramento da organização com período de retenção/grace period.
 */
export async function scheduleOrganizationDeletion(
  supabase: SupabaseClient,
  orgId: string,
  motivo: string,
  diasRetencao = 30,
  authorId?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('agendar_encerramento_organizacao', {
    p_org_id: orgId,
    p_motivo: motivo,
    p_dias_retencao: diasRetencao,
    p_autor_id: authorId ?? null,
  });

  if (error) {
    throw new Error(`Falha ao agendar encerramento da organizacao: ${error.message}`);
  }

  return data as string;
}

/**
 * Cancela o agendamento de encerramento durante o grace period.
 */
export async function cancelOrganizationDeletion(
  supabase: SupabaseClient,
  orgId: string,
  authorId?: string,
): Promise<void> {
  return executeLifecycleStatusTransition(supabase, 'cancelar_agendamento_encerramento', orgId, undefined, authorId);
}

/**
 * Executa o encerramento definitivo e anonimização de dados pessoais.
 */
export async function executeOrganizationPurge(
  supabase: SupabaseClient,
  orgId: string,
  motivo = 'Encerramento de ciclo e periodo de retencao',
): Promise<void> {
  const { error } = await supabase.rpc('executar_encerramento_definitivo', {
    p_org_id: orgId,
    p_motivo: motivo,
  });

  if (error) {
    throw new Error(`Falha ao purgar organizacao: ${error.message}`);
  }
}

/**
 * Valida se a organização está ativa. Lança OrganizationInactiveError se estiver inativa.
 */
export async function assertOrganizationActive(
  supabase: SupabaseClient,
  orgId: string,
): Promise<OrganizationLifecycleState> {
  const { data, error } = await supabase
    .from('organizacoes')
    .select('status, suspenso_em, motivo_suspensao, exclusao_agendada_para, encerrado_em')
    .eq('id', orgId)
    .single();

  if (error || !data) {
    throw new Error(`Organizacao nao encontrada: ${error?.message ?? orgId}`);
  }

  const state: OrganizationLifecycleState = {
    status: (data.status as OrganizationLifecycleStatus) || 'active',
    suspensoEm: data.suspenso_em,
    motivoSuspensao: data.motivo_suspensao,
    exclusaoAgendadaPara: data.exclusao_agendada_para,
    encerradoEm: data.encerrado_em,
  };

  if (state.status !== 'active') {
    throw new OrganizationInactiveError(
      state.status,
      `Operacao bloqueada: organizacao ${orgId} com status '${state.status}'`,
    );
  }

  return state;
}
