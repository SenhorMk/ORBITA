import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectAislopDiagnosticCounts,
  findAislopRegressions,
  findUnlistedDiagnostics,
} from './aislop-ratchet.mjs';

describe('AI slop ratchet', () => {
  it('flags a diagnostic introduced in a previously clean file', () => {
    const diagnostic = {
      filePath: 'src/new.ts',
      engine: 'ai-slop',
      rule: 'ai-slop/example',
      severity: 'warning',
      message: 'New debt.',
    };
    const current = collectAislopDiagnosticCounts([diagnostic]);

    expect(findAislopRegressions(current, {})).toEqual([
      expect.stringContaining('src/new.ts'),
    ]);
  });

  it('allows an inherited diagnostic to be removed', () => {
    const baseline = {
      'src/old.ts|ai-slop|ai-slop/example|warning|Old debt.': 1,
    };

    expect(findAislopRegressions({}, baseline)).toEqual([]);
  });
});

describe('allowlist do aislop: a exceção temporária do braces é exata', () => {
  const allowlist = JSON.parse(readFileSync(path.resolve('quality/aislop-allowlist.json'), 'utf8')) as {
    exceptions: Array<{ fingerprint: string; owner: string; ticket: string; date: string; reason: string }>;
  };
  const BRACES = 'package.json|security|security/vulnerable-dependency|error|braces (high) — upgrade to aislop@0.18.1';
  const advisory = (message: string, overrides: Record<string, string> = {}) => ({
    filePath: 'package.json', engine: 'security', rule: 'security/vulnerable-dependency', severity: 'error', message, ...overrides,
  });

  it('o fingerprint exato do braces é aceito', () => {
    expect(findUnlistedDiagnostics([advisory('braces (high) — upgrade to aislop@0.18.1')], allowlist)).toEqual([]);
  });

  it('qualquer outro advisory continua reprovando', () => {
    expect(findUnlistedDiagnostics([advisory('minimist (high) — upgrade to minimist@1.2.9')], allowlist))
      .toEqual(['package.json|security|security/vulnerable-dependency|error|minimist (high) — upgrade to minimist@1.2.9']);
  });

  it('mudar qualquer parte material do fingerprint não é coberto', () => {
    const variantes = [
      advisory('braces (critical) — upgrade to aislop@0.18.1'),
      // As recomendações ANTERIORES deste advisory (0.6.0, 0.18.0) e uma versão futura não são cobertas.
      advisory('braces (high) — upgrade to aislop@0.6.0'),
      advisory('braces (high) — upgrade to aislop@0.18.0'),
      advisory('braces (high) — upgrade to aislop@0.18.2'),
      advisory('braces (high) — upgrade to aislop@0.19.0'),
      advisory('braces (high) — transitive — needs override or parent upgrade'),
      advisory('braces (high) — upgrade to aislop@0.18.1 (2 advisories)'),
      advisory('micromatch (high) — upgrade to aislop@0.18.1'),
      advisory('braces (high) — upgrade to aislop@0.18.1', { filePath: 'apps/outro/package.json' }),
      advisory('braces (high) — upgrade to aislop@0.18.1', { rule: 'security/outra-regra' }),
      advisory('braces (high) — upgrade to aislop@0.18.1', { engine: 'code-quality' }),
      advisory('braces (high) — upgrade to aislop@0.18.1', { severity: 'warning' }),
    ];
    for (const variante of variantes) {
      expect(findUnlistedDiagnostics([variante], allowlist), JSON.stringify(variante)).toHaveLength(1);
    }
  });

  it('sem curinga: cada exceção é um fingerprint literal de cinco partes, e a do braces aparece uma vez', () => {
    for (const { fingerprint } of allowlist.exceptions) {
      expect(fingerprint.split('|'), fingerprint).toHaveLength(5);
      expect(fingerprint, fingerprint).not.toMatch(/[*?]|\.\*/u);
    }
    expect(allowlist.exceptions.filter((e) => e.fingerprint === BRACES)).toHaveLength(1);
  });

  it('a exceção é documentada: responsável explícito, follow-up, data e motivo temporário', () => {
    const braces = allowlist.exceptions.find((e) => e.fingerprint === BRACES)!;
    expect(braces.owner).not.toBe('needs-owner');
    expect(braces.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(braces.ticket).toContain('GHSA-vfj7-8cjw-p6xm');
    for (const termo of ['TEMPORARY', 'GHSA-vfj7-8cjw-p6xm', 'CVE-2026-93687', '--omit=dev', 'no fixed version']) {
      expect(braces.reason).toContain(termo);
    }
  });

  it('a exceção não silencia o audit de produção: audit:check é npm audit direto e não lê a allowlist', () => {
    const pacote = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pacote.scripts['audit:check']).toBe('npm audit --omit=dev --audit-level=high');
    const workflows = readdirSync(path.resolve('.github/workflows')).map((f) => readFileSync(path.resolve('.github/workflows', f), 'utf8')).join('\n');
    expect(workflows).toContain('npm run audit:check');
    // Só o gate do aislop consulta a allowlist.
    const consumidores = readdirSync(path.resolve('scripts'))
      .filter((f) => /\.(mjs|ts)$/u.test(f) && !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(path.resolve('scripts', f), 'utf8').includes('aislop-allowlist.json'));
    expect(consumidores).toEqual(['check-aislop-ratchet.mjs']);
  });
});
