/**
 * Estado persistido dos jobs de sincronização Bling → ORBITA (`sync_jobs`).
 *
 * Problema: sincronizar uma conta leva tempo, e a requisição HTTP não pode
 * ficar aberta esperando. Também não pode haver duas sincronizações da mesma
 * organização rodando juntas.
 *
 * Como funciona:
 * - `POST /api/sync` registra o job (`enqueueJob`). Se já existe um job
 *   `queued`/`running` na organização, a RPC devolve esse mesmo job em vez de
 *   criar outro. A rota responde `202` — "aceito", não "concluído" — e dispara
 *   o processamento com `after()`, depois de a resposta sair;
 * - antes de trabalhar, o processo pede o lease do job (`acquireLease`): uma
 *   posse temporária (10 min, renovada a cada avanço). Com lease válido nas mãos
 *   de outro processo, este desiste;
 * - a cada etapa concluída (clientes, produtos, pedidos) o progresso é gravado
 *   em `sync_jobs.progress` (`advanceCheckpoint`) — é ele que a tela acompanha.
 *   Apesar do nome da função, isso **não** é o checkpoint incremental: aquele
 *   fica em `sync_state` (`syncCheckpoint.ts`) e diz a partir de quando pedir
 *   dados ao Bling. Um registra o andamento DESTE job; o outro evita reler
 *   dados antigos do fornecedor na próxima sincronização;
 * - `GET /api/sync/status` lê o estado depois.
 *
 * Limites: não há agendador externo — o job só é processado pelo `after()` de
 * uma requisição. Um lease vencido faz o job voltar a `queued`
 * (`releaseExpiredLeases`), mas ele só roda de novo quando alguém chama o
 * processamento, e aí recomeça da primeira etapa: o progresso gravado não é
 * usado para pular etapas nem páginas (produtos e pedidos só evitam reler tudo
 * pelo checkpoint incremental de `syncCheckpoint.ts`). As funções que recebem
 * escopo operam só em jobs da organização verificada; `releaseExpiredLeases` é
 * uma limpeza global de leases vencidos.
 */
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
