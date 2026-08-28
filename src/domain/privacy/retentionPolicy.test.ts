/**
 * retentionPolicy.test.ts
 * Ticket 18: RED primeiro. Testes puros, relógio sempre injetado via
 * parâmetro `now: Date` — nunca `Date.now()`/`new Date()` dentro da lógica
 * testada (mesmo padrão de `titularVerificationService.ts`, ticket 17).
 */

import { describe, expect, it } from 'vitest';
import {
  computeCutoff,
  evaluateRetentionEligibility,
  PLACEHOLDER_POLICY_STATUS,
} from './retentionPolicy';

describe('computeCutoff', () => {
  it('subtrai o prazo em dias por época UTC (imune a fuso/DST)', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    const cutoff = computeCutoff(now, 30);
    expect(cutoff.toISOString()).toBe('2026-07-29T12:00:00.000Z');
  });

  it('não desloca com a transição de horário de verão em America/Sao_Paulo (histórico, ano com DST)', () => {
    // 2018-11-04 foi o início do horário de verão no Brasil (naquele ano). O
    // cálculo é feito inteiramente em época UTC (ms), então a duração exata
    // de `prazoDias * 86400000` nunca é afetada por deslocamento de fuso —
    // decisão documentada: ORBITA não aplica calendário local ao prazo de
    // retenção, apenas duração fixa em UTC.
    const now = new Date('2018-11-10T00:00:00.000Z');
    const cutoff = computeCutoff(now, 10);
    expect(now.getTime() - cutoff.getTime()).toBe(10 * 24 * 60 * 60 * 1000);
  });

  it('rejeita prazo não positivo (política mal configurada nunca deve rodar)', () => {
    expect(() => computeCutoff(new Date('2026-01-01T00:00:00.000Z'), 0)).toThrow();
    expect(() => computeCutoff(new Date('2026-01-01T00:00:00.000Z'), -5)).toThrow();
  });
});

describe('evaluateRetentionEligibility', () => {
  const cutoff = new Date('2026-07-29T12:00:00.000Z');

  it('exatamente ANTES do cutoff (1ms) não é elegível', () => {
    const result = evaluateRetentionEligibility({
      entityClockValue: new Date(cutoff.getTime() + 1),
      cutoff,
      legalHold: false,
      alreadyProcessed: false,
      policyStatus: 'approved',
    });
    expect(result).toEqual({ eligible: false, reason: 'before_cutoff' });
  });

  it('exatamente NO cutoff (mesmo instante) é elegível — fronteira inclusiva documentada', () => {
    const result = evaluateRetentionEligibility({
      entityClockValue: new Date(cutoff.getTime()),
      cutoff,
      legalHold: false,
      alreadyProcessed: false,
      policyStatus: 'approved',
    });
    expect(result).toEqual({ eligible: true });
  });

  it('exatamente DEPOIS do cutoff (1ms) é elegível', () => {
    const result = evaluateRetentionEligibility({
      entityClockValue: new Date(cutoff.getTime() - 1),
      cutoff,
      legalHold: false,
      alreadyProcessed: false,
      policyStatus: 'approved',
    });
    expect(result).toEqual({ eligible: true });
  });

  it('legal hold sempre vence mesmo com cutoff vencido', () => {
    const result = evaluateRetentionEligibility({
      entityClockValue: new Date(cutoff.getTime() - 1000),
      cutoff,
      legalHold: true,
      alreadyProcessed: false,
      policyStatus: 'approved',
    });
    expect(result).toEqual({ eligible: false, reason: 'legal_hold' });
  });

  it('item já processado (anonimizado/eliminado) nunca é reprocessado', () => {
    const result = evaluateRetentionEligibility({
      entityClockValue: new Date(cutoff.getTime() - 1000),
      cutoff,
      legalHold: false,
      alreadyProcessed: true,
      policyStatus: 'approved',
    });
    expect(result).toEqual({ eligible: false, reason: 'already_processed' });
  });

  it('política pending_approval nunca é elegível, mesmo com cutoff vencido — needs-owner até aprovação', () => {
    const result = evaluateRetentionEligibility({
      entityClockValue: new Date(cutoff.getTime() - 1000),
      cutoff,
      legalHold: false,
      alreadyProcessed: false,
      policyStatus: PLACEHOLDER_POLICY_STATUS,
    });
    expect(result).toEqual({ eligible: false, reason: 'policy_not_approved' });
  });

  it('política disabled nunca é elegível', () => {
    const result = evaluateRetentionEligibility({
      entityClockValue: new Date(cutoff.getTime() - 1000),
      cutoff,
      legalHold: false,
      alreadyProcessed: false,
      policyStatus: 'disabled',
    });
    expect(result).toEqual({ eligible: false, reason: 'policy_not_approved' });
  });

  it('legal hold tem prioridade sobre already_processed na mensagem de motivo (hold é a razão de negócio mais forte)', () => {
    const result = evaluateRetentionEligibility({
      entityClockValue: new Date(cutoff.getTime() - 1000),
      cutoff,
      legalHold: true,
      alreadyProcessed: true,
      policyStatus: 'approved',
    });
    expect(result).toEqual({ eligible: false, reason: 'legal_hold' });
  });
});
