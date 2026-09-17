/**
 * retentionPolicy.ts
 * Núcleo puro de decisão de retenção/anonimização/eliminação.
 * Independente de Next.js/Supabase — nunca chama `Date.now()`/`new Date()`
 * internamente; todo relógio é injetado pelo chamador (`now`/`entityClockValue`
 * já resolvidos), mesmo padrão de `titularVerificationService.ts`.
 *
 * Decisão documentada sobre fuso horário: o prazo de retenção é uma duração
 * fixa em milissegundos por época UTC (`prazoDias * 86_400_000`), nunca um
 * cálculo por calendário local. Isso torna o cutoff imune a transições de
 * horário de verão (o Brasil aboliu o DST em 2019, mas o histórico de dados
 * anteriores a essa data ainda pode existir) — a duração de "N dias" nunca
 * varia com o fuso do titular. Se um requisito jurídico futuro exigir
 * "N dias corridos no calendário de São Paulo" em vez de duração fixa, isso
 * é uma mudança de política que precisa de decisão explícita do dono
 * (`needs-owner`), não uma correção silenciosa aqui.
 */

/** Nenhum prazo real foi aprovado ainda: a definição depende de revisão
 * jurídica e da proprietária. Este status trava qualquer elegibilidade até a
 * aprovação. */
export const PLACEHOLDER_POLICY_STATUS = 'pending_approval' as const;

export type RetentionPolicyStatus = 'pending_approval' | 'approved' | 'disabled';

export type RetentionAction = 'retain' | 'anonymize' | 'delete';

/** Calcula o instante-limite (cutoff): entidades com relógio inicial igual ou
 * anterior a este instante são candidatas à ação da política. */
export function computeCutoff(now: Date, prazoDias: number): Date {
  if (!Number.isFinite(prazoDias) || prazoDias <= 0) {
    throw new Error(
      `computeCutoff: prazoDias deve ser um inteiro positivo (recebido ${String(prazoDias)}). ` +
        'Uma política de retenção sem prazo positivo nunca deve ser executada.',
    );
  }
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - prazoDias * MS_PER_DAY);
}

export type RetentionEligibilityReason =
  | 'before_cutoff'
  | 'legal_hold'
  | 'already_processed'
  | 'policy_not_approved';

export type RetentionEligibilityResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: RetentionEligibilityReason };

export interface RetentionEligibilityInput {
  /** Valor da coluna de relógio inicial da entidade (ex.: `updated_at`). */
  readonly entityClockValue: Date;
  readonly cutoff: Date;
  readonly legalHold: boolean;
  readonly alreadyProcessed: boolean;
  readonly policyStatus: RetentionPolicyStatus;
}

/**
 * Decisão pura e determinística de elegibilidade — a MESMA função é usada
 * pelo seletor de dry-run e pelo seletor de execução (a única diferença
 * entre os dois modos é o adapter de efeito aplicado depois, nunca esta
 * função). Ordem de prioridade dos motivos de negação, do mais forte ao mais
 * fraco: política não aprovada > legal hold > já processado > antes do
 * cutoff.
 */
export function evaluateRetentionEligibility(input: RetentionEligibilityInput): RetentionEligibilityResult {
  if (input.policyStatus !== 'approved') {
    return { eligible: false, reason: 'policy_not_approved' };
  }
  if (input.legalHold) {
    return { eligible: false, reason: 'legal_hold' };
  }
  if (input.alreadyProcessed) {
    return { eligible: false, reason: 'already_processed' };
  }
  // Fronteira inclusiva: um item cujo relógio é exatamente igual ao cutoff já
  // completou o prazo (>= , não >) — decisão documentada, coberta por teste.
  if (input.entityClockValue.getTime() > input.cutoff.getTime()) {
    return { eligible: false, reason: 'before_cutoff' };
  }
  return { eligible: true };
}
