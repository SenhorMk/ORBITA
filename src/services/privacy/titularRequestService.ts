/**
 * titularRequestService.ts
 * Ticket 17: application service que orquestra a jornada de direitos do
 * titular. Recebe sempre ator/escopo já verificados (nunca aceita
 * `organizacao_id`/capability enviados pelo cliente como autoridade) e
 * delega a decisão de transição à máquina de estados pura
 * (`titularRequestStateMachine.ts`). Persistência via um port explícito —
 * testável com um fake escrito à mão, sem `vi.mock`.
 */

import {
  applyTitularRequestEvent,
  type TitularRequestEvent,
  type VersionedTitularRequestState,
} from '@/domain/privacy/titularRequestStateMachine';
import type { AdapterOutcome, DireitoTipo, TarefaSistema, TitularSystemAdapter, TitularTaskContext } from './adapters/types';

export interface OperatorScope {
  readonly organizationId: string;
  readonly actorId: string;
  readonly hasManageCapability: boolean;
}

export interface TitularRequestRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly titularTipo: 'lojista_user' | 'cliente_final';
  readonly titularRefUserId: string | null;
  readonly titularRefClienteId: string | null;
  readonly tipoDireito: DireitoTipo;
  readonly state: VersionedTitularRequestState;
}

export interface TitularRequestRepositoryPort {
  findById(id: string): Promise<TitularRequestRecord | null>;
  saveTransition(id: string, next: VersionedTitularRequestState): Promise<void>;
  recordTaskOutcome(
    requestId: string,
    sistema: TarefaSistema,
    outcome: AdapterOutcome,
  ): Promise<void>;
}

export type ReviewDecisionOutcome =
  | { readonly _tag: 'Applied'; readonly next: VersionedTitularRequestState }
  | { readonly _tag: 'Denied'; readonly reason: 'not_authorized' | 'cross_tenant' | 'not_found' }
  | { readonly _tag: 'RejectedByStateMachine'; readonly reason: string };

/**
 * Um operador (owner/admin com `organization:manage`) decide sobre uma
 * solicitação verificada. Um `member` sem essa capability é sempre negado
 * antes mesmo de a máquina de estados ser consultada — autoridade é checada
 * primeiro, nunca "tentamos e vemos se dá erro".
 */
export async function decideTitularRequest(
  deps: { readonly repository: TitularRequestRepositoryPort },
  params: {
    readonly requestId: string;
    readonly operator: OperatorScope;
    readonly decision: 'review_started' | 'approved' | 'partially_denied' | 'denied';
    readonly reasonCode?: string;
    readonly occurredAt: string;
    readonly correlationId: string;
  },
): Promise<ReviewDecisionOutcome> {
  if (!params.operator.hasManageCapability) {
    return { _tag: 'Denied', reason: 'not_authorized' };
  }

  const record = await deps.repository.findById(params.requestId);
  if (!record) return { _tag: 'Denied', reason: 'not_found' };

  if (record.organizationId !== params.operator.organizationId) {
    // Nunca revela se a solicitação existe em outra organização — mesmo
    // motivo de negação de "não autorizado".
    return { _tag: 'Denied', reason: 'cross_tenant' };
  }

  const event: TitularRequestEvent = {
    type: params.decision,
    occurredAt: params.occurredAt,
    version: record.state.version + 1,
    actorId: params.operator.actorId,
    reasonCode: params.reasonCode,
  };

  const outcome = applyTitularRequestEvent(record.state, event);
  if (outcome.outcome !== 'applied') {
    return { _tag: 'RejectedByStateMachine', reason: outcome.outcome === 'rejected_stale' || outcome.outcome === 'rejected_invalid_transition' || outcome.outcome === 'rejected_missing_reason' ? outcome.reason : 'evento_duplicado' };
  }

  await deps.repository.saveTransition(record.id, outcome.next);
  return { _tag: 'Applied', next: outcome.next };
}

export type ExecutionSummaryEntry = { readonly sistema: TarefaSistema; readonly outcome: AdapterOutcome };

export interface ExecuteRequestResult {
  readonly finalState: 'completed' | 'failed';
  readonly summary: ReadonlyArray<ExecutionSummaryEntry>;
}

/**
 * Executa a solicitação já aprovada contra todos os adapters de sistema
 * alcançado. Nunca esconde um sistema que falhou: todo adapter registrado é
 * chamado e seu resultado persistido, mesmo que outro já tenha falhado.
 * `failed`/`retryable` de qualquer adapter impede o estado final
 * `completed` — a solicitação só é `completed` quando todo sistema
 * respondeu `completed`, `not_found` ou `retained_with_reason`.
 */
export async function executeTitularRequest(
  deps: { readonly repository: TitularRequestRepositoryPort },
  params: {
    readonly request: TitularRequestRecord;
    readonly adapters: ReadonlyArray<TitularSystemAdapter>;
    readonly changes?: Readonly<Record<string, unknown>>;
    readonly correlationId: string;
  },
): Promise<ExecuteRequestResult> {
  const context: TitularTaskContext = {
    organizationId: params.request.organizationId,
    titularTipo: params.request.titularTipo,
    titularRefUserId: params.request.titularRefUserId,
    titularRefClienteId: params.request.titularRefClienteId,
    solicitacaoId: params.request.id,
    correlationId: params.correlationId,
  };

  const summary: ExecutionSummaryEntry[] = [];
  for (const adapter of params.adapters) {
    let outcome: AdapterOutcome;
    try {
      outcome = await adapter.execute(params.request.tipoDireito, context, params.changes);
    } catch (err) {
      // Nunca um catch vazio: exceção inesperada de um adapter vira `failed`
      // com o erro registrado, nunca interrompe o processamento dos demais
      // sistemas (não esconder sistema faltante).
      outcome = { status: 'failed', erro: err instanceof Error ? err.message : String(err) };
    }
    await deps.repository.recordTaskOutcome(params.request.id, adapter.sistema, outcome);
    summary.push({ sistema: adapter.sistema, outcome });
  }

  const anyBlocking = summary.some((s) => s.outcome.status === 'failed' || s.outcome.status === 'retryable');
  return { finalState: anyBlocking ? 'failed' : 'completed', summary };
}
