/**
 * consentPolicy.ts
 * ConsentPolicy pura, independente de framework.
 *
 * Não há hoje nenhuma categoria opcional real no produto (ver
 * docs/privacy/cookie-registry.md — nenhum cookie/SDK preferences/analytics/marketing
 * foi encontrado no código). Este módulo é preparado antecipadamente para quando uma
 * categoria opcional real existir: nenhuma rota deve reimplementar lógica de
 * concessão/retirada de consentimento fora daqui.
 *
 * Regras:
 * - `essential` é sempre concedida e nunca pode ser revogada (auth/CSRF/organização não
 *   dependem de consentimento opcional).
 * - Estado inicial ("primeira visita") não tem nenhuma decisão registrada para
 *   categorias opcionais — elas ficam implicitamente não concedidas até uma decisão
 *   explícita (aceitar/rejeitar/granular).
 * - `reject_all` registra uma decisão explícita "negada" (distinta de "nunca decidiu"),
 *   porque rejeitar deve ser tão válido/visível quanto aceitar.
 * - Mudança de versão do aviso invalida (volta a "não decidida") apenas as categorias
 *   cuja finalidade/materialidade o chamador explicitamente identificou como afetada;
 *   as demais decisões são preservadas com a versão original em que foram tomadas.
 * - Não persiste nenhum dado identificável de pessoa real: `actorRef` deve ser um
 *   identificador anônimo/pseudônimo opaco fornecido pelo chamador, não um e-mail/nome.
 */

export type ConsentCategory = 'essential' | 'preferences' | 'analytics' | 'marketing';

export const ALL_CONSENT_CATEGORIES: readonly ConsentCategory[] = [
  'essential',
  'preferences',
  'analytics',
  'marketing',
];

export const OPTIONAL_CONSENT_CATEGORIES: readonly Exclude<ConsentCategory, 'essential'>[] = [
  'preferences',
  'analytics',
  'marketing',
];

export interface ConsentDecisionRecord {
  readonly granted: boolean;
  readonly noticeVersion: string;
  readonly decidedAt: string;
}

/**
 * Estado de consentimento de um único actor (pseudônimo/anônimo). `decisions` só contém
 * entradas para categorias opcionais sobre as quais já houve uma decisão explícita;
 * `essential` nunca aparece aqui (é sempre concedida implicitamente).
 */
export interface ConsentState {
  readonly actorRef: string;
  readonly noticeVersion: string;
  readonly decisions: Readonly<Partial<Record<ConsentCategory, ConsentDecisionRecord>>>;
}

export type ConsentAction =
  | { readonly kind: 'accept_all' }
  | { readonly kind: 'reject_all' }
  | { readonly kind: 'granular'; readonly categories: Readonly<Partial<Record<ConsentCategory, boolean>>> }
  | { readonly kind: 'withdraw'; readonly category: ConsentCategory };

export type ConsentPolicyError = {
  readonly code: 'ESSENTIAL_CANNOT_BE_REVOKED';
  readonly reason: string;
};

export type ConsentDecisionResult =
  | { readonly ok: true; readonly state: ConsentState }
  | { readonly ok: false; readonly error: ConsentPolicyError };

const ESSENTIAL_ERROR: ConsentPolicyError = {
  code: 'ESSENTIAL_CANNOT_BE_REVOKED',
  reason: 'A categoria "essential" é obrigatória para autenticação/CSRF/organização e nunca pode ser revogada.',
};

/**
 * Cria o estado inicial ("primeira visita"): nenhuma decisão explícita registrada para
 * categorias opcionais — só `essential` está implicitamente concedida.
 */
export function createInitialConsentState(actorRef: string, noticeVersion: string): ConsentState {
  return {
    actorRef,
    noticeVersion,
    decisions: {},
  };
}

/** `essential` é sempre concedida; demais categorias dependem de decisão explícita registrada. */
export function isCategoryGranted(state: ConsentState, category: ConsentCategory): boolean {
  if (category === 'essential') return true;
  return state.decisions[category]?.granted ?? false;
}

export function recordDecision(state: ConsentState, action: ConsentAction, now: string): ConsentDecisionResult {
  switch (action.kind) {
    case 'accept_all': {
      const decisions: Partial<Record<ConsentCategory, ConsentDecisionRecord>> = { ...state.decisions };
      for (const category of OPTIONAL_CONSENT_CATEGORIES) {
        decisions[category] = { granted: true, noticeVersion: state.noticeVersion, decidedAt: now };
      }
      return { ok: true, state: { ...state, decisions } };
    }
    case 'reject_all': {
      const decisions: Partial<Record<ConsentCategory, ConsentDecisionRecord>> = { ...state.decisions };
      for (const category of OPTIONAL_CONSENT_CATEGORIES) {
        decisions[category] = { granted: false, noticeVersion: state.noticeVersion, decidedAt: now };
      }
      return { ok: true, state: { ...state, decisions } };
    }
    case 'granular': {
      const entries = Object.entries(action.categories) as [ConsentCategory, boolean][];
      const essentialRevoked = entries.some(([category, granted]) => category === 'essential' && granted === false);
      if (essentialRevoked) {
        return { ok: false, error: ESSENTIAL_ERROR };
      }
      const decisions: Partial<Record<ConsentCategory, ConsentDecisionRecord>> = { ...state.decisions };
      for (const [category, granted] of entries) {
        if (category === 'essential') continue; // sempre concedida, nada a registrar
        decisions[category] = { granted, noticeVersion: state.noticeVersion, decidedAt: now };
      }
      return { ok: true, state: { ...state, decisions } };
    }
    case 'withdraw': {
      if (action.category === 'essential') {
        return { ok: false, error: ESSENTIAL_ERROR };
      }
      const decisions: Partial<Record<ConsentCategory, ConsentDecisionRecord>> = {
        ...state.decisions,
        [action.category]: { granted: false, noticeVersion: state.noticeVersion, decidedAt: now },
      };
      return { ok: true, state: { ...state, decisions } };
    }
  }
}

/**
 * Aplica uma nova versão do aviso ao estado. `categoriesRequiringNewDecision` deve ser
 * decidido pelo chamador (não adivinhado aqui) com base em qual finalidade/materialidade
 * mudou entre versões — só essas categorias voltam a "não decidida"; as demais mantêm a
 * decisão e a versão original em que foram tomadas.
 */
export function reconcileWithNoticeVersion(
  state: ConsentState,
  newNoticeVersion: string,
  categoriesRequiringNewDecision: readonly ConsentCategory[],
): ConsentState {
  if (categoriesRequiringNewDecision.includes('essential')) {
    throw new Error(
      'reconcileWithNoticeVersion: "essential" nunca exige nova decisão de consentimento (auth/CSRF/organização não dependem de consentimento opcional).',
    );
  }

  const decisions: Partial<Record<ConsentCategory, ConsentDecisionRecord>> = { ...state.decisions };
  for (const category of categoriesRequiringNewDecision) {
    delete decisions[category];
  }

  return { ...state, noticeVersion: newNoticeVersion, decisions };
}
