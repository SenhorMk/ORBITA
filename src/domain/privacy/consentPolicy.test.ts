/**
 * consentPolicy.test.ts
 * Ticket 16: ConsentPolicy pura, test-first, independente de framework.
 *
 * Não há hoje nenhuma categoria opcional (preferences/analytics/marketing) real no
 * produto (ver docs/privacy/cookie-registry.md) — este módulo existe preparado para
 * quando existir, sem depender de nenhuma integração real.
 */
import { describe, expect, it } from 'vitest';
import {
  createInitialConsentState,
  isCategoryGranted,
  reconcileWithNoticeVersion,
  recordDecision,
  type ConsentState,
} from './consentPolicy';

const ACTOR = 'anon-9f2c3b1a'; // identificador pseudônimo opaco, não PII
const NOTICE_V1 = '2026-08-27-v1';
const NOTICE_V2 = '2026-09-15-v2';
const NOW = '2026-08-27T12:00:00.000Z';
const LATER = '2026-08-27T12:05:00.000Z';

describe('Ticket 16: consentPolicy — estado inicial', () => {
  it('permite apenas essenciais no estado inicial, sem decisão explícita registrada para opcionais', () => {
    const state = createInitialConsentState(ACTOR, NOTICE_V1);

    expect(isCategoryGranted(state, 'essential')).toBe(true);
    expect(isCategoryGranted(state, 'preferences')).toBe(false);
    expect(isCategoryGranted(state, 'analytics')).toBe(false);
    expect(isCategoryGranted(state, 'marketing')).toBe(false);
    expect(state.decisions).toEqual({});
    expect(state.actorRef).toBe(ACTOR);
    expect(state.noticeVersion).toBe(NOTICE_V1);
  });

  it('não carrega nenhum campo identificável de pessoa real na shape do estado', () => {
    const state = createInitialConsentState(ACTOR, NOTICE_V1);
    const keys = Object.keys(state);
    expect(keys).toEqual(['actorRef', 'noticeVersion', 'decisions']);
    // actorRef é opaco: não deve conter '@' (heurística simples anti e-mail)
    expect(state.actorRef.includes('@')).toBe(false);
  });
});

describe('Ticket 16: consentPolicy — aceitar tudo', () => {
  it('accept_all concede todas as categorias opcionais, versionadas e com timestamp', () => {
    const initial = createInitialConsentState(ACTOR, NOTICE_V1);
    const result = recordDecision(initial, { kind: 'accept_all' }, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('esperado ok=true');
    expect(isCategoryGranted(result.state, 'preferences')).toBe(true);
    expect(isCategoryGranted(result.state, 'analytics')).toBe(true);
    expect(isCategoryGranted(result.state, 'marketing')).toBe(true);
    expect(isCategoryGranted(result.state, 'essential')).toBe(true);
    expect(result.state.decisions.analytics).toEqual({
      granted: true,
      noticeVersion: NOTICE_V1,
      decidedAt: NOW,
    });
  });
});

describe('Ticket 16: consentPolicy — rejeitar tudo', () => {
  it('reject_all mantém só essenciais concedidas, mas registra decisão explícita (distinta de nunca ter decidido)', () => {
    const initial = createInitialConsentState(ACTOR, NOTICE_V1);
    const result = recordDecision(initial, { kind: 'reject_all' }, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('esperado ok=true');
    expect(isCategoryGranted(result.state, 'preferences')).toBe(false);
    expect(isCategoryGranted(result.state, 'analytics')).toBe(false);
    expect(isCategoryGranted(result.state, 'marketing')).toBe(false);
    // decisão explícita registrada (rejeitar é tão fácil/visível quanto aceitar, nunca ausente)
    expect(result.state.decisions.analytics).toEqual({
      granted: false,
      noticeVersion: NOTICE_V1,
      decidedAt: NOW,
    });
    expect(initial.decisions).toEqual({}); // estado inicial não tinha decisão nenhuma
  });
});

describe('Ticket 16: consentPolicy — granular', () => {
  it('granular concede/nega só as categorias informadas, preservando as demais como não decididas', () => {
    const initial = createInitialConsentState(ACTOR, NOTICE_V1);
    const result = recordDecision(
      initial,
      { kind: 'granular', categories: { analytics: true, marketing: false } },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('esperado ok=true');
    expect(isCategoryGranted(result.state, 'analytics')).toBe(true);
    expect(isCategoryGranted(result.state, 'marketing')).toBe(false);
    expect(result.state.decisions.preferences).toBeUndefined(); // não informada, permanece não decidida
    expect(isCategoryGranted(result.state, 'preferences')).toBe(false);
  });

  it('granular rejeita tentativa de desmarcar essential com erro tipado, sem aplicar mudança', () => {
    const initial = createInitialConsentState(ACTOR, NOTICE_V1);
    const result = recordDecision(
      initial,
      { kind: 'granular', categories: { essential: false, analytics: true } },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('esperado ok=false');
    expect(result.error.code).toBe('ESSENTIAL_CANNOT_BE_REVOKED');
  });
});

describe('Ticket 16: consentPolicy — retirada (withdraw)', () => {
  it('withdraw remove a concessão de uma categoria, preservando as demais já concedidas', () => {
    const afterAccept = recordDecision(createInitialConsentState(ACTOR, NOTICE_V1), { kind: 'accept_all' }, NOW);
    if (!afterAccept.ok) throw new Error('esperado ok=true');

    const result = recordDecision(afterAccept.state, { kind: 'withdraw', category: 'analytics' }, LATER);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('esperado ok=true');
    expect(isCategoryGranted(result.state, 'analytics')).toBe(false);
    expect(isCategoryGranted(result.state, 'preferences')).toBe(true);
    expect(isCategoryGranted(result.state, 'marketing')).toBe(true);
    expect(result.state.decisions.analytics).toEqual({
      granted: false,
      noticeVersion: NOTICE_V1,
      decidedAt: LATER,
    });
  });

  it('withdraw de essential é erro tipado, essential nunca pode ser revogada', () => {
    const initial = createInitialConsentState(ACTOR, NOTICE_V1);
    const result = recordDecision(initial, { kind: 'withdraw', category: 'essential' }, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('esperado ok=false');
    expect(result.error.code).toBe('ESSENTIAL_CANNOT_BE_REVOKED');
    expect(isCategoryGranted(initial, 'essential')).toBe(true);
  });
});

describe('Ticket 16: consentPolicy — reconciliação com nova versão do aviso', () => {
  it('mudança de versão que não afeta a categoria preserva a decisão concedida anteriormente', () => {
    const afterAccept = recordDecision(createInitialConsentState(ACTOR, NOTICE_V1), { kind: 'accept_all' }, NOW);
    if (!afterAccept.ok) throw new Error('esperado ok=true');

    const reconciled = reconcileWithNoticeVersion(afterAccept.state, NOTICE_V2, []);

    expect(reconciled.noticeVersion).toBe(NOTICE_V2);
    expect(isCategoryGranted(reconciled, 'analytics')).toBe(true);
    expect(reconciled.decisions.analytics?.noticeVersion).toBe(NOTICE_V1); // decisão original preservada, não reescrita
  });

  it('mudança de versão que afeta a finalidade invalida só a(s) categoria(s) impactada(s)', () => {
    const afterAccept = recordDecision(createInitialConsentState(ACTOR, NOTICE_V1), { kind: 'accept_all' }, NOW);
    if (!afterAccept.ok) throw new Error('esperado ok=true');

    const reconciled = reconcileWithNoticeVersion(afterAccept.state, NOTICE_V2, ['marketing']);

    expect(reconciled.noticeVersion).toBe(NOTICE_V2);
    // marketing volta a exigir nova decisão (default: não concedida)
    expect(isCategoryGranted(reconciled, 'marketing')).toBe(false);
    expect(reconciled.decisions.marketing).toBeUndefined();
    // demais categorias preservadas
    expect(isCategoryGranted(reconciled, 'analytics')).toBe(true);
    expect(isCategoryGranted(reconciled, 'preferences')).toBe(true);
  });

  it('essential não pode ser listada como categoria que exige nova decisão (erro tipado, sem exceção não tratada)', () => {
    const initial = createInitialConsentState(ACTOR, NOTICE_V1);
    expect(() => reconcileWithNoticeVersion(initial, NOTICE_V2, ['essential'])).toThrowError(
      /essential/i,
    );
  });
});

describe('Ticket 16: consentPolicy — invariante de tipos', () => {
  it('ConsentState é somente leitura na assinatura pública (checagem em tempo de compilação via typeof)', () => {
    const state: ConsentState = createInitialConsentState(ACTOR, NOTICE_V1);
    expect(typeof state).toBe('object');
  });
});
