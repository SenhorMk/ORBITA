import { describe, expect, it } from 'vitest';

import {
  applyCanonicalMigrations,
  DATABASE_LAB_CLEANUP,
  databaseLabCycleSteps,
  parseLocalOnlyPlan,
  runDatabaseLab,
} from './database-lab.mjs';
import { err, ok } from './script-result.mjs';

describe('database lab lifecycle', () => {
  it('pins every destructive or test operation to the local database', () => {
    expect(parseLocalOnlyPlan()._tag).toBe('ok');

    const commandArguments = [...databaseLabCycleSteps(1), DATABASE_LAB_CLEANUP]
      .flatMap(({ args }) => args);

    expect(commandArguments).not.toContain('--linked');
    expect(commandArguments).not.toContain('--project-ref');
    expect(commandArguments).not.toContain('--db-url');
    expect(DATABASE_LAB_CLEANUP.args).toContain('--no-backup');
  });

  it('rejects a remote-capable command even when no remote flag is present', () => {
    const unsafePlan = [{ name: 'push database', args: ['db', 'push'] }];
    const result = parseLocalOnlyPlan(unsafePlan, DATABASE_LAB_CLEANUP);
    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error.message).toContain('is not allowlisted');
  });

  it('destroys the dedicated lab after a failure in the middle of the migration chain', async () => {
    const executedSteps: string[] = [];
    const execute = async (step: { name: string }) => {
      executedSteps.push(step.name);
      return ok({ step: step.name });
    };
    const result = await runDatabaseLab({
      // O alinhamento do esqueleto de `auth` fala com o Postgres do laboratorio,
      // que nao existe aqui: entra como fake, igual as demais fronteiras.
      alinharAuth: async () => ok({ coluna: 'auth.users.email_confirmed_at' }),
      execute,
      runMigrationTests: async () => ok({ files: 0, assertions: 0 }),
      applyMigrations: async () => err('MigrationApplyFailed', 'migration failed after order 18'),
      captureCatalog: async () => ok('unused'),
      validateLedger: () => ok({ checkedFiles: 1 }),
      cycles: 1,
    });

    expect(result._tag).toBe('err');
    expect(executedSteps.at(-1)).toBe('destroy isolated Supabase lab');
  });

  it('recreates two independent clean cycles and compares their catalog fingerprints', async () => {
    const executedSteps: string[] = [];
    const cycleEvents: string[] = [];
    let migrationRuns = 0;
    let catalogCaptures = 0;
    const result = await runDatabaseLab({
      // O alinhamento do esqueleto de `auth` fala com o Postgres do laboratorio,
      // que nao existe aqui: entra como fake, igual as demais fronteiras.
      alinharAuth: async () => ok({ coluna: 'auth.users.email_confirmed_at' }),
      execute: async (step: { name: string }) => {
        executedSteps.push(step.name);
        return ok({ step: step.name });
      },
      runMigrationTests: async () => {
        cycleEvents.push('historical pgTAP rollback');
        return ok({ files: 0, assertions: 0 });
      },
      applyMigrations: async () => {
        migrationRuns += 1;
        cycleEvents.push('canonical migration chain');
        return ok([]);
      },
      captureCatalog: async () => {
        catalogCaptures += 1;
        cycleEvents.push('final catalog');
        return ok('same-catalog');
      },
      validateLedger: () => ok({ checkedFiles: 1 }),
      cycles: 2,
    });

    expect(migrationRuns).toBe(2);
    expect(catalogCaptures).toBe(2);
    expect(executedSteps.filter((stepName) => stepName === DATABASE_LAB_CLEANUP.name)).toHaveLength(3);
    expect(cycleEvents).toEqual([
      'historical pgTAP rollback', 'canonical migration chain', 'final catalog',
      'historical pgTAP rollback', 'canonical migration chain', 'final catalog',
    ]);
    expect(result).toEqual({ _tag: 'ok', value: { catalogFingerprint: 'same-catalog', cycles: 2 } });
  });

  it('fails closed before Docker when the canonical ledger is stale', async () => {
    const executedSteps: string[] = [];
    const result = await runDatabaseLab({
      // O alinhamento do esqueleto de `auth` fala com o Postgres do laboratorio,
      // que nao existe aqui: entra como fake, igual as demais fronteiras.
      alinharAuth: async () => ok({ coluna: 'auth.users.email_confirmed_at' }),
      execute: async (step: { name: string }) => {
        executedSteps.push(step.name);
        return ok({ step: step.name });
      },
      validateLedger: () => err('DatabaseDriftDetected', 'checksum mismatch'),
    });

    expect(result._tag).toBe('err');
    expect(executedSteps).toEqual([]);
  });

  it('runs teardown when an injected dependency throws unexpectedly', async () => {
    const executedSteps: string[] = [];
    const result = await runDatabaseLab({
      // O alinhamento do esqueleto de `auth` fala com o Postgres do laboratorio,
      // que nao existe aqui: entra como fake, igual as demais fronteiras.
      alinharAuth: async () => ok({ coluna: 'auth.users.email_confirmed_at' }),
      execute: async (step: { name: string }) => {
        executedSteps.push(step.name);
        return ok({ step: step.name });
      },
      applyMigrations: async () => {
        throw new Error('unexpected adapter defect');
      },
      runMigrationTests: async () => ok({ files: 0, assertions: 0 }),
      validateLedger: () => ok({ checkedFiles: 1 }),
      cycles: 1,
    });

    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error._tag).toBe('UnexpectedDatabaseLabFailure');
    expect(executedSteps.at(-1)).toBe(DATABASE_LAB_CLEANUP.name);
  });

  it('preserves safe diagnostics when both the primary operation and cleanup fail', async () => {
    let cleanupRuns = 0;
    const result = await runDatabaseLab({
      // O alinhamento do esqueleto de `auth` fala com o Postgres do laboratorio,
      // que nao existe aqui: entra como fake, igual as demais fronteiras.
      alinharAuth: async () => ok({ coluna: 'auth.users.email_confirmed_at' }),
      execute: async (step: { name: string }) => {
        if (step.name === DATABASE_LAB_CLEANUP.name) {
          cleanupRuns += 1;
          if (cleanupRuns > 1) return err('SupabaseStepFailed', 'cleanup failed');
        }
        return ok({ step: step.name });
      },
      applyMigrations: async () => err('MigrationApplyFailed', 'migration failed'),
      runMigrationTests: async () => ok({ files: 0, assertions: 0 }),
      validateLedger: () => ok({ checkedFiles: 1 }),
      cycles: 1,
    });

    expect(result._tag).toBe('err');
    if (result._tag === 'err') {
      expect(result.error._tag).toBe('DatabaseLabCleanupFailed');
      expect(result.error.primaryFailure).toEqual({ tag: 'MigrationApplyFailed', message: 'migration failed' });
      expect(result.error.cleanupFailure).toEqual({ tag: 'SupabaseStepFailed', message: 'cleanup failed' });
    }
  });

  it('aplica a pré-condição de dados da ordem 104 antes do arquivo canônico e a remove depois', async () => {
    const consultas: string[] = [];
    const client = { connect: async () => {}, end: async () => {}, query: async (sql: string) => { consultas.push(sql); } };
    const migrations = [103, 104].map((order) => ({ order, path: `../database/m${order}.sql`, sha256: `${order}`.padEnd(64, '0') }));
    const fileSystem = { readFileSync: (p: string) => `-- canonical ${p}` } as never;
    const result = await applyCanonicalMigrations({ client, ledgerResult: ok({ migrations }), fileSystem });
    expect(result._tag).toBe('ok');
    expect(consultas).toHaveLength(4);
    expect(consultas[0]).toContain('m103.sql');
    expect(consultas[1]).toContain("insert into public.chatwoot_ai_runtime");
    expect(consultas[1]).toContain("'10', false");
    expect(consultas[2]).toContain('m104.sql');
    expect(consultas[3]).toContain('delete from public.chatwoot_ai_runtime');
  });

  it('mostra o SQLSTATE e a mensagem do Postgres quando uma migration falha', async () => {
    const erro = Object.assign(new Error('Escopo WhatsApp mudou; rollback obrigatório'), { code: 'P0001' });
    const client = { connect: async () => {}, end: async () => {}, query: async () => { throw erro; } };
    const migrations = [{ order: 104, path: '../database/m104.sql', sha256: '1'.padEnd(64, '0') }];
    const fileSystem = { readFileSync: () => 'select 1' } as never;
    const result = await applyCanonicalMigrations({ client, ledgerResult: ok({ migrations }), fileSystem });
    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error.message).toContain('P0001 | Escopo WhatsApp mudou');
  });
});
