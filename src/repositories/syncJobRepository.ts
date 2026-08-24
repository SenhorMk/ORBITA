import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

export type SyncJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SyncJobProgress {
  clientes_processados?: number;
  produtos_processados?: number;
  pedidos_processados?: number;
  etapa_atual?: 'clientes' | 'produtos' | 'pedidos' | 'concluido';
  pagina_atual?: number;
}

export interface SyncJob {
  id: string;
  organizacao_id: string;
  triggered_by: string | null;
  status: SyncJobStatus;
  progress: SyncJobProgress;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EnqueueResult {
  jobId: string;
  status: SyncJobStatus;
  isNew: boolean;
}

export async function enqueueJob(
  scope: VerifiedOrganizationScope,
): Promise<EnqueueResult> {
  const { data, error } = await supabaseServer.rpc('registrar_job_sync', {
    p_organizacao_id: scope.organizationId,
    p_triggered_by: scope.actorId,
  });

  if (error) {
    throw new Error(`Falha ao registrar job de sincronização: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error('RPC registrar_job_sync não retornou dados.');
  }

  return {
    jobId: row.job_id as string,
    status: row.status as SyncJobStatus,
    isNew: row.is_new as boolean,
  };
}

export async function acquireLease(
  scope: VerifiedOrganizationScope,
  jobId: string,
  leaseTtlMinutes = 10,
): Promise<boolean> {
  await assertJobBelongsToScope(scope, jobId);
  const { data, error } = await supabaseServer.rpc('adquirir_lease_job_sync', {
    p_job_id: jobId,
    p_lease_ttl_min: leaseTtlMinutes,
  });

  if (error) {
    throw new Error(`Falha ao adquirir lease do job ${jobId}: ${error.message}`);
  }

  return data === true;
}

export async function advanceCheckpoint(
  scope: VerifiedOrganizationScope,
  jobId: string,
  progress: SyncJobProgress,
): Promise<void> {
  await assertJobBelongsToScope(scope, jobId);
  const { error } = await supabaseServer.rpc('avancar_checkpoint_job_sync', {
    p_job_id: jobId,
    p_progress: progress,
  });

  if (error) {
    throw new Error(`Falha ao avançar checkpoint do job ${jobId}: ${error.message}`);
  }
}

export async function completeJob(
  scope: VerifiedOrganizationScope,
  jobId: string,
  status: 'completed' | 'failed' | 'cancelled',
  error?: string,
): Promise<void> {
  await assertJobBelongsToScope(scope, jobId);
  const { error: rpcError } = await supabaseServer.rpc('concluir_job_sync', {
    p_job_id: jobId,
    p_status: status,
    p_error: error ?? null,
  });

  if (rpcError) {
    throw new Error(`Falha ao concluir job ${jobId}: ${rpcError.message}`);
  }
}

export async function getJobStatus(
  scope: VerifiedOrganizationScope,
  jobId: string,
): Promise<SyncJob | null> {
  const { data, error } = await supabaseServer
    .from('sync_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('organizacao_id', scope.organizationId)
    .maybeSingle();

  if (error) {
    throw new Error(`Falha ao obter status do job ${jobId}: ${error.message}`);
  }

  return data as SyncJob | null;
}

async function assertJobBelongsToScope(
  scope: VerifiedOrganizationScope,
  jobId: string,
): Promise<void> {
  const job = await getJobStatus(scope, jobId);
  if (!job) throw new Error('Job não pertence à organização verificada.');
}

export async function releaseExpiredLeases(): Promise<number> {
  const { data, error } = await supabaseServer.rpc(
    'liberar_leases_expirados_sync',
  );

  if (error) {
    console.warn('⚠️ sync_jobs: falha ao liberar leases expirados:', error.message);
    return 0;
  }

  return (data as number) ?? 0;
}
