import { describe, expect, it } from 'vitest';

import {
  collectDiagnosticCounts,
  findLintRegressions,
  normalizeDiagnosticMessage,
} from './lint-ratchet.mjs';

describe('lint ratchet', () => {
  it('flags a diagnostic moved to a previously clean file', () => {
    const message = {
      severity: 2,
      ruleId: 'example/no-debt',
      message: 'Existing debt must not move.',
    };
    const baseline = collectDiagnosticCounts([
      { filePath: '/repo/old.ts', messages: [message] },
    ], '/repo');
    const current = collectDiagnosticCounts([
      { filePath: '/repo/new.ts', messages: [message] },
    ], '/repo');

    expect(findLintRegressions(current, baseline)).toEqual([
      expect.stringContaining('new.ts'),
    ]);
  });

  it('allows an existing diagnostic to be removed', () => {
    const baseline = {
      'src/old.ts|2|example/no-debt|Existing debt.': 1,
    };

    expect(findLintRegressions({}, baseline)).toEqual([]);
  });

  it('normalizes platform-specific paths and code frames out of messages', () => {
    const windowsMessage = [
      'Error: Hook rule failed.',
      'C:\\repo\\src\\page.tsx:10:3 8 | before > 10 | call();',
    ].join(' ');
    const linuxMessage = [
      'Error: Hook rule failed.',
      '/repo/src/page.tsx:10:3 8 | before > 10 | call();',
    ].join(' ');

    expect(normalizeDiagnosticMessage(windowsMessage, 'C:\\repo')).toBe(
      normalizeDiagnosticMessage(linuxMessage, '/repo'),
    );
  });
});
