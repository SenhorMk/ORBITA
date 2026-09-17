/**
 * retentionRunService.ts
 * Orquestra um run de retenção (dry-run ou execução) contra um
 * lote de candidatos já selecionado. Mesmo padrão de
 * `titularRequestService.ts`: porta de repositório explícita,
 * testável com fake escrito à mão; decisão de elegibilidade delegada à
 * função pura `evaluateRetentionEligibility` (`retentionPolicy.ts`) — a
 * MESMA função para dry-run e execução, só o adapter de efeito muda.
 *
 * Autoridade: `organizationId`/`categoria`/`policyVersao` sempre vêm de um
 * contexto já verificado pelo chamador (nunca de entrada de cliente sem
 * verificação) — este serviço não decide autoridade, só orquestra o
 * mecanismo depois que a autoridade já foi checada.
 */

import { evaluateRetentionEligibility, type RetentionPolicyStatus } from '@/domain/privacy/retentionPolicy';
import { descreverErro } from '@/lib/erroLegivel';
import type {
  RetentionAction,
  RetentionEffectAdapter,
  RetentionEffectContext,
  RetentionItemOutcome,
} from './adapters/retentionTypes';

export interface RetentionCandidate {
  readonly entidadeId: string;
  readonly entityClockValue: Date;
  readonly legalHold: boolean;
  readonly alreadyProcessed: boolean;
}

/** Porta de persistência do mecanismo de retenção. A chave de idempotência do
 * run é responsabilidade do repositório (deve ser determinística a partir de
 * `organizationId + categoria + policyVersao + modo + cutoff` — exatamente o
 * que a migration 51 impõe via `unique` constraint em Postgres). */
export interface RetentionRunRepositoryPort {
  startOrGetRun(idempotencyKey: string): Promise<{ readonly runId: string; readonly alreadyExisted: boolean }>;
  /** Reivindica (claim) um lote de candidatos ainda não finalizados desta
   * run — nunca retorna um item já reivindicado por outra chamada
   * concorrente (equivalente a `FOR UPDATE SKIP LOCKED`). */
  selectCandidates(runId: string, cutoffIso: string, limit: number): Promise<RetentionCandidate[]>;
  recordItemOutcome(runId: string, entidadeId: string, status: string, erro?: string): Promise<void>;
  finalizeRun(runId: string, finalStatus: 'completed' | 'completed_with_errors'): Promise<void>;
}

export type RetentionMode = 'dry_run' | 'execute';

export interface RunRetentionParams {
  readonly organizationId: string;
  readonly categoria: string;
  readonly policyVersao: number;
  readonly policyStatus: RetentionPolicyStatus;
  readonly prazoDias: number;
  readonly action: RetentionAction;
  readonly modo: RetentionMode;
  readonly now: Date;
  readonly correlationId: string;
  readonly batchLimit: number;
}

export interface RunRetentionResult {
  readonly runId: string;
  readonly modo: RetentionMode;
  readonly selected: number;
  readonly processed: number;
  readonly failed: number;
  readonly skippedLegalHold: number;
  readonly skippedAlreadyProcessed: number;
  readonly skippedBeforeCutoff: number;
  readonly skippedPolicyNotApproved: number;
  readonly finalStatus: 'completed' | 'completed_with_errors';
}

function buildIdempotencyKey(params: RunRetentionParams, cutoffIso: string): string {
  return [params.organizationId, params.categoria, params.policyVersao, params.modo, cutoffIso].join('::');
}

/** Prazo é resolvido para o cutoff pelo chamador via `computeCutoff` — este
 * serviço recebe `prazoDias`/`now` e recalcula localmente para manter a
 * chave de idempotência e a decisão de elegibilidade coerentes no mesmo
 * lugar. */
function cutoffFor(params: RunRetentionParams): Date {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return new Date(params.now.getTime() - params.prazoDias * MS_PER_DAY);
}

export async function runRetention(
  deps: { readonly repository: RetentionRunRepositoryPort; readonly adapters: ReadonlyArray<RetentionEffectAdapter> },
  params: RunRetentionParams,
): Promise<RunRetentionResult> {
  const cutoff = cutoffFor(params);
  const cutoffIso = cutoff.toISOString();
  const idempotencyKey = buildIdempotencyKey(params, cutoffIso);
  const { runId } = await deps.repository.startOrGetRun(idempotencyKey);

  const candidates = await deps.repository.selectCandidates(runId, cutoffIso, params.batchLimit);

  let processed = 0;
  let failed = 0;
  let skippedLegalHold = 0;
  let skippedAlreadyProcessed = 0;
  let skippedBeforeCutoff = 0;
  let skippedPolicyNotApproved = 0;

  const context: RetentionEffectContext = {
    organizationId: params.organizationId,
    categoria: params.categoria,
    runId,
    correlationId: params.correlationId,
  };

  const bancoAdapter = deps.adapters.find((a) => a.sistema === 'banco');

  for (const candidate of candidates) {
    const eligibility = evaluateRetentionEligibility({
      entityClockValue: candidate.entityClockValue,
      cutoff,
      legalHold: candidate.legalHold,
      alreadyProcessed: candidate.alreadyProcessed,
      policyStatus: params.policyStatus,
    });

    if (!eligibility.eligible) {
      switch (eligibility.reason) {
        case 'legal_hold':
          skippedLegalHold += 1;
          await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'skipped_legal_hold');
          break;
        case 'already_processed':
          skippedAlreadyProcessed += 1;
          await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'skipped_already_processed');
          break;
        case 'policy_not_approved':
          skippedPolicyNotApproved += 1;
          await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'skipped_policy_not_approved');
          break;
        case 'before_cutoff':
        default:
          skippedBeforeCutoff += 1;
          await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'skipped_before_cutoff');
          break;
      }
      continue;
    }

    if (params.modo === 'dry_run') {
      // Dry-run nunca invoca `apply` em nenhum adapter — só `preview`, que é
      // proibido de causar efeito observável fora do processo.
      if (bancoAdapter) {
        await bancoAdapter.preview(params.action, candidate.entidadeId, context);
      }
      processed += 1;
      await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'skipped_dry_run_previewed');
      continue;
    }

    // modo === 'execute'
    if (!bancoAdapter) {
      failed += 1;
      await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'failed', 'Nenhum adapter "banco" registrado.');
      continue;
    }

    let outcome: RetentionItemOutcome;
    try {
      outcome = await bancoAdapter.apply(params.action, candidate.entidadeId, context);
    } catch (err) {
      // Nunca um catch vazio: exceção inesperada do adapter vira `failed`
      // com o erro registrado, sem interromper os demais candidatos do
      // lote (falha de um item nunca esconde os demais).
      outcome = { status: 'failed' as const, erro: descreverErro(err) };
    }

    if (outcome.status === 'done') {
      processed += 1;
      await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'done');
    } else if (outcome.status === 'skipped_already_processed') {
      skippedAlreadyProcessed += 1;
      await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'skipped_already_processed');
    } else {
      failed += 1;
      const erro = outcome.status === 'failed' ? outcome.erro : outcome.motivo;
      await deps.repository.recordItemOutcome(runId, candidate.entidadeId, 'failed', erro);
    }
  }

  // Falha parcial NUNCA marca o run como concluído com sucesso — mesmo que a
  // maioria do lote tenha processado corretamente.
  const finalStatus: 'completed' | 'completed_with_errors' = failed > 0 ? 'completed_with_errors' : 'completed';
  await deps.repository.finalizeRun(runId, finalStatus);

  return {
    runId,
    modo: params.modo,
    selected: candidates.length,
    processed,
    failed,
    skippedLegalHold,
    skippedAlreadyProcessed,
    skippedBeforeCutoff,
    skippedPolicyNotApproved,
    finalStatus,
  };
}
