import { describe, expect, it, vi } from 'vitest';

import {
  assertLocalOnlyPlan,
  DATABASE_LAB_CLEANUP,
  DATABASE_LAB_STEPS,
  runDatabaseLab,
} from './database-lab.mjs';

describe('database lab lifecycle', () => {
  it('pins every destructive or test operation to the local database', () => {
    expect(() => assertLocalOnlyPlan()).not.toThrow();

    const commandArguments = [...DATABASE_LAB_STEPS, DATABASE_LAB_CLEANUP]
      .flatMap(({ args }) => args);

    expect(commandArguments).not.toContain('--linked');
    expect(commandArguments).not.toContain('--project-ref');
    expect(commandArguments).not.toContain('--db-url');
    expect(DATABASE_LAB_CLEANUP.args).toContain('--no-backup');
  });

  it('rejects a remote-capable command even when no remote flag is present', () => {
    const unsafePlan = [
      { name: 'push database', args: ['db', 'push'] },
    ];

    expect(() => assertLocalOnlyPlan(unsafePlan, DATABASE_LAB_CLEANUP))
      .toThrow('is not allowlisted');
  });

  it('destroys the dedicated lab when a database test fails', () => {
    const executedSteps: string[] = [];
    const execute = vi.fn((step: { name: string }) => {
      executedSteps.push(step.name);
      if (step.name === 'run pgTAP database tests') {
        throw new Error('test failure');
      }
    });

    expect(() => runDatabaseLab({ execute })).toThrow('test failure');
    expect(executedSteps.at(-1)).toBe('destroy isolated Supabase lab');
  });
});
