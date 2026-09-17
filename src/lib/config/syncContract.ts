import { z } from 'zod';

/**
 * Contrato único das respostas de `POST /api/sync` e `GET /api/sync/status`.
 *
 * A sincronização é um **job durável**: `POST /api/sync` responde
 * `202 { success, jobId, status }` — enfileira, não conclui — e o progresso é
 * lido em `GET /api/sync/status`. A tela valida as respostas por estes schemas
 * em vez de supor a forma: um cliente que esperasse estatísticas na resposta
 * do `POST` trataria uma sincronização enfileirada com sucesso como erro.
 */

export const syncJobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type SyncJobStatusValue = z.infer<typeof syncJobStatusSchema>;

/** Resposta de `POST /api/sync`: o job foi aceito, não concluído. */
export const syncEnqueueResponseSchema = z.object({
  success: z.literal(true),
  jobId: z.string().min(1),
  status: syncJobStatusSchema,
});

export type SyncEnqueueResponse = z.infer<typeof syncEnqueueResponseSchema>;

export const syncJobProgressSchema = z.object({
  clientes_processados: z.number().optional(),
  produtos_processados: z.number().optional(),
  pedidos_processados: z.number().optional(),
  etapa_atual: z.enum(['clientes', 'produtos', 'pedidos', 'concluido']).optional(),
  pagina_atual: z.number().optional(),
});

/** Resposta de `GET /api/sync/status?job_id=`. */
export const syncStatusResponseSchema = z.object({
  success: z.literal(true),
  job: z.object({
    id: z.string().min(1),
    status: syncJobStatusSchema,
    progress: syncJobProgressSchema,
    last_error: z.string().nullable(),
    completed_at: z.string().nullable(),
  }),
});

export type SyncStatusResponse = z.infer<typeof syncStatusResponseSchema>;

/** Estados em que o job ainda pode avançar. */
export function jobEmAndamento(status: SyncJobStatusValue): boolean {
  return status === 'queued' || status === 'running';
}

/** Frase de progresso a partir do estado real do job, sem inventar números. */
export function descreverProgresso(job: SyncStatusResponse['job']): string {
  const { progress } = job;
  const totais = [
    progress.clientes_processados !== undefined ? `${progress.clientes_processados} clientes` : null,
    progress.produtos_processados !== undefined ? `${progress.produtos_processados} produtos` : null,
    progress.pedidos_processados !== undefined ? `${progress.pedidos_processados} pedidos` : null,
  ].filter((parte): parte is string => parte !== null);

  if (job.status === 'completed') {
    return totais.length > 0 ? `Sincronizado! ${totais.join(', ')}.` : 'Sincronização concluída.';
  }
  if (job.status === 'failed') {
    return `Sincronização falhou: ${job.last_error ?? 'sem detalhe informado pelo servidor'}`;
  }
  if (job.status === 'cancelled') {
    return 'Sincronização cancelada.';
  }

  const etapa = progress.etapa_atual ? ` (${progress.etapa_atual})` : '';
  return totais.length > 0
    ? `Sincronizando${etapa}: ${totais.join(', ')}...`
    : `Sincronização em andamento${etapa}...`;
}
