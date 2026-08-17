import { describe, expect, it } from 'vitest';

import {
  collectAislopDiagnosticCounts,
  findAislopRegressions,
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
