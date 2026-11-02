/**
 * Worker do outbox: executa uma passada de entrega dos eventos pendentes.
 *
 * Divisão de responsabilidades:
 * - `OutboxService` mantém o estado durável no Postgres: enfileiramento
 *   idempotente, claim com lease e fencing token, tentativas e desfechos;
 * - este worker orquestra uma passada (liberar leases vencidas → reivindicar
 *   lote → iniciar despacho → chamar o adapter → gravar o desfecho) e executa
 *   **apenas os adapters que o chamador fornecer**.
 *
 * Limite real do sistema atual: o worker não agenda a própria execução e não
 * registra adapters de produção. Não há, no código atual, rota, cron ou
 * processo que monte adapters reais e chame `runOutboxWorkerOnce` ou
 * `drainOutboxWorker` — eles só são exercitados por testes. O consumidor real
 * do Chatwoot é do MSG-008.
 *
 * Semântica de entrega (MSG-007): o despacho só começa depois que o banco
 * grava `in_flight` para este fencing token. Daí em diante, só um recibo do
 * provedor confirma, e tudo que não prova a não aplicação — timeout, ACK
 * perdido, resposta inválida, exceção do adapter, lease vencida — vira
 * `unknown`, que nenhum claim seguinte reenvia.
 */
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/observability/logger';
import { outboxService } from '@/services/outboxService';
import type { ClaimedOutboxEvent, OutboxDestination, OutboxStatus } from '@/services/outboxService';
import {
  desfechoDeFalhaAposDespacho,
  validarDesfecho,
  type DesfechoDoDespacho,
} from './desfechoDoEfeito';

/**
 * One provider adapter per outbox destination. It performs the external
 * effect and reports one of the four outcomes; only the adapter knows the
 * provider contract, so only it can claim proof of non-application. Its
 * result is validated before it is recorded.
 */
export type OutboxProviderAdapter = (event: ClaimedOutboxEvent) => Promise<DesfechoDoDespacho>;

/** Called once per event that ended `unknown`, for audit. Never throws into the worker. */
export type ObservadorDeDesconhecido = (event: ClaimedOutboxEvent, desfecho: DesfechoDoDespacho) => Promise<void>;

export interface OutboxWorkerDeps {
  readonly supabase: SupabaseClient;
  readonly workerId: string;
  readonly providers: Partial<Record<OutboxDestination, OutboxProviderAdapter>>;
  readonly limit?: number;
  readonly leaseTtlSeconds?: number;
  readonly aoFicarDesconhecido?: ObservadorDeDesconhecido;
  /** Injectable for tests; defaults to the real outboxService singleton. */
  readonly outbox?: Pick<
    typeof outboxService,
    'releaseExpiredLeases' | 'claimBatch' | 'startDispatch' | 'concludeAttempt'
  >;
}

export interface OutboxWorkerRunSummary {
  readonly claimed: number;
  readonly sent: number;
  readonly failedTransient: number;
  readonly deadLettered: number;
  readonly unknown: number;
  /** Posse perdida antes do despacho ou na conclusão (lease/fencing). */
  readonly fenced: number;
  readonly reaped: number;
}

type Contagem = { -readonly [K in keyof OutboxWorkerRunSummary]: OutboxWorkerRunSummary[K] };
type OutboxDoWorker = NonNullable<OutboxWorkerDeps['outbox']>;

function contar(contagem: Contagem, status: OutboxStatus | null): void {
  if (status === 'sent') contagem.sent++;
  else if (status === 'failed_transient') contagem.failedTransient++;
  else if (status === 'dead_letter') contagem.deadLettered++;
  else if (status === 'unknown') contagem.unknown++;
  else if (status === null) contagem.fenced++;
}

function contexto(event: ClaimedOutboxEvent) {
  return {
    subsystem: 'queue' as const,
    correlationId: event.correlation_id ?? undefined,
    organizacaoId: event.organizacao_id,
    eventoId: event.evento_id,
    destino: event.destination,
    tipo: event.event_type,
    fencingToken: event.fencing_token,
  };
}

async function processar(deps: OutboxWorkerDeps, outbox: OutboxDoWorker, event: ClaimedOutboxEvent, contagem: Contagem) {
  const posse = { eventoId: event.evento_id, workerId: deps.workerId, fencingToken: event.fencing_token };
  const adapter = deps.providers[event.destination];

  if (!adapter) {
    // Configuração, não falha do provedor: nada foi despachado e nada
    // despachará este destino. Recusa definitiva a partir do claim.
    contar(contagem, await outbox.concludeAttempt(deps.supabase, posse, {
      _tag: 'Recusado',
      categoria: 'permanent',
      codigo: 'sem_adapter',
      erro: `Nenhum adapter registrado para destination=${event.destination}.`,
    }));
    return;
  }

  if (!(await outbox.startDispatch(deps.supabase, event.evento_id, deps.workerId, event.fencing_token))) {
    logger.warn('outbox: posse perdida antes do despacho; nada enviado', contexto(event));
    contagem.fenced++;
    return;
  }
  logger.info('outbox: despacho iniciado', contexto(event));

  let desfecho: DesfechoDoDespacho;
  try {
    desfecho = validarDesfecho(await adapter(event));
  } catch {
    desfecho = desfechoDeFalhaAposDespacho();
  }

  const status = await outbox.concludeAttempt(deps.supabase, posse, desfecho);
  contar(contagem, status);
  if (status === null) {
    logger.warn('outbox: conclusão recusada pelo fencing; o desfecho fica para a reconciliação', {
      ...contexto(event),
      desfecho: desfecho._tag,
    });
    return;
  }
  logger.info('outbox: desfecho gravado', { ...contexto(event), desfecho: desfecho._tag, status });
  if (status === 'unknown' && deps.aoFicarDesconhecido) {
    await deps.aoFicarDesconhecido(event, desfecho).catch(() => {
      logger.error('outbox: auditoria do efeito desconhecido falhou', contexto(event));
    });
  }
}

/**
 * Runs exactly one pass of the outbox worker: releases expired leases (crash
 * recovery), claims a bounded batch, starts each dispatch under its fencing
 * token, calls the adapter and records the outcome. This is a plain invocable
 * async function — no `setInterval`/timer is part of the durable queue. A
 * caller that wants continuous processing owns that scheduling decision; no
 * such caller exists in the current codebase.
 */
export async function runOutboxWorkerOnce(deps: OutboxWorkerDeps): Promise<OutboxWorkerRunSummary> {
  const outbox = deps.outbox ?? outboxService;
  const limit = deps.limit ?? 20;
  const leaseTtlSeconds = deps.leaseTtlSeconds ?? 300;

  const reaped = await outbox.releaseExpiredLeases(deps.supabase);
  const batch = await outbox.claimBatch(deps.supabase, deps.workerId, limit, leaseTtlSeconds);

  const contagem: Contagem = {
    claimed: batch.length, sent: 0, failedTransient: 0, deadLettered: 0, unknown: 0, fenced: 0, reaped: reaped.length,
  };
  for (const event of batch) {
    await processar(deps, outbox, event, contagem);
  }
  return contagem;
}

/** Generate a stable-enough worker instance id for observability/lease
 * ownership. Callers may supply their own (e.g. a pod name); this is only a
 * convenience default, never authority. */
export function generateWorkerId(prefix = 'outbox-worker'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Runs the worker in a bounded loop until the queue is empty or
 * `maxIterations` is reached, honoring an external abort signal for graceful
 * shutdown. Still no in-memory timer: this is a single invocable call a
 * caller makes once (e.g. from a cron trigger or a drain command), not a
 * background scheduler living in process memory. Like `runOutboxWorkerOnce`,
 * it currently has no production caller.
 */
export async function drainOutboxWorker(
  deps: OutboxWorkerDeps,
  options: { readonly maxIterations?: number; readonly signal?: AbortSignal } = {},
): Promise<OutboxWorkerRunSummary[]> {
  const maxIterations = options.maxIterations ?? 50;
  const summaries: OutboxWorkerRunSummary[] = [];

  for (let i = 0; i < maxIterations; i++) {
    if (options.signal?.aborted) break;
    const summary = await runOutboxWorkerOnce(deps);
    summaries.push(summary);
    if (summary.claimed === 0) break;
  }

  return summaries;
}
