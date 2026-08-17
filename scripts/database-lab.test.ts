import { describe, expect, it, vi } from 'vitest';

import {
  assertLocalOnlyPlan,
  DATABASE_LAB_CLEANUP,
  DATABASE_LAB_STEPS,
  generatedIncludePath,
  prepareDatabaseTestIncludes,
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

    expect(() => runDatabaseLab({
      execute,
      prepareIncludes() {},
      cleanupIncludes() {},
    })).toThrow('test failure');
    expect(executedSteps.at(-1)).toBe('destroy isolated Supabase lab');
  });

  it('copies canonical SQL into a non-test include consumed by pgTAP', () => {
    const copiedFiles: Array<{ source: string; destination: string }> = [];
    const fileSystem = {
      mkdirSync() {
        return undefined;
      },
      readdirSync() {
        return ['09_harden_grants_and_rpcs.sql', 'notes.md'];
      },
      copyFileSync(source: string, destination: string) {
        copiedFiles.push({ source, destination });
      },
    };

    prepareDatabaseTestIncludes(fileSystem);

    expect(copiedFiles).toEqual([{
      source: expect.stringMatching(/database[\\/]09_harden_grants_and_rpcs\.sql$/),
      destination: generatedIncludePath('09_harden_grants_and_rpcs.sql'),
    }]);
    expect(copiedFiles[0]?.destination).toMatch(/\.inc$/);
  });
});
