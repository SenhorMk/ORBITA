import { describe, expect, it } from 'vitest';

import { failureMessage } from './script-result.mjs';

describe('script failure output', () => {
  it('shows both safe diagnostics for a combined failure without rendering causes', () => {
    const output = failureMessage({
      _tag: 'DatabaseLabCleanupFailed',
      message: 'Database lab cleanup failed after cycle 1',
      primaryFailure: { tag: 'MigrationApplyFailed', message: 'migration 18 failed' },
      cleanupFailure: { tag: 'SupabaseStepFailed', message: 'local teardown failed' },
      cause: { password: 'must-not-appear' },
    });

    expect(output).toBe([
      'Database lab cleanup failed after cycle 1',
      'primary: [MigrationApplyFailed] migration 18 failed',
      'cleanup: [SupabaseStepFailed] local teardown failed',
    ].join('\n'));
    expect(output).not.toContain('must-not-appear');
  });
});
