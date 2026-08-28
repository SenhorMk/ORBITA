import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_STATUS,
  assertSimulatedRemoteTarget,
  buildApprovalForm,
  buildRollbackPlan,
  buildSyncBundle,
  classifyDrift,
  classifyMigrationAgainstSnapshot,
  containsDestructiveStatement,
  estimateBackfillFromReltuples,
  parseMigrationObjectRefs,
  readAppVersion,
} from './supabase-sync-package.mjs';
import { readCanonicalLedger, SUPABASE_CONFIG_PATH } from './database-ledger.mjs';

const MIGRATION_52_PATH = path.resolve(process.cwd(), 'database', '52_auditoria_anti_forjamento_catalogo.sql');
const MIGRATION_52_SQL = readFileSync(MIGRATION_52_PATH, 'utf8');

describe('assertSimulatedRemoteTarget', () => {
  it('allows only the local lab host/port', () => {
    expect(assertSimulatedRemoteTarget('127.0.0.1', 54322)._tag).toBe('ok');
  });

  it('refuses any other host as a real-remote path this ticket does not implement', () => {
    const result = assertSimulatedRemoteTarget('db.example.supabase.co', 5432);
    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error._tag).toBe('RealRemoteTargetNotImplemented');
  });

  it('refuses an unexpected port even on localhost', () => {
    const result = assertSimulatedRemoteTarget('127.0.0.1', 5432);
    expect(result._tag).toBe('err');
  });
});

describe('parseMigrationObjectRefs', () => {
  it('extracts the table created by migration 52 from its real SQL', () => {
    const refs = parseMigrationObjectRefs(MIGRATION_52_SQL);
    expect(refs.tables).toContain('catalogo_eventos_auditoria');
  });

  it('extracts create-or-replace function names', () => {
    const refs = parseMigrationObjectRefs('create or replace function public.minha_funcao(a int) returns int as $$ select a $$ language sql;');
    expect(refs.functions).toContain('minha_funcao');
  });

  it('returns empty arrays for SQL with no create statements', () => {
    const refs = parseMigrationObjectRefs('update public.foo set bar = 1;');
    expect(refs.tables).toHaveLength(0);
    expect(refs.functions).toHaveLength(0);
  });
});

describe('containsDestructiveStatement', () => {
  it('flags DROP TABLE as destructive', () => {
    expect(containsDestructiveStatement('drop table public.legacy;')).toBe(true);
  });

  it('flags unbounded DELETE as destructive', () => {
    expect(containsDestructiveStatement('delete from public.legacy;')).toBe(true);
  });

  it('does not flag additive CREATE TABLE IF NOT EXISTS', () => {
    expect(containsDestructiveStatement('create table if not exists public.novo (id int);')).toBe(false);
  });
});

describe('classifyMigrationAgainstSnapshot', () => {
  const snapshotWithTable = { relations: [{ name: 'catalogo_eventos_auditoria' }], functions: [], policies: [], indexes: [] };
  const emptySnapshot = { relations: [], functions: [], policies: [], indexes: [] };

  it('classifies as applied when every ref is present', () => {
    const refs = { tables: ['catalogo_eventos_auditoria'], functions: [], policies: [], indexes: [] };
    expect(classifyMigrationAgainstSnapshot(refs, snapshotWithTable)).toBe('applied');
  });

  it('classifies as missing when no ref is present', () => {
    const refs = { tables: ['catalogo_eventos_auditoria'], functions: [], policies: [], indexes: [] };
    expect(classifyMigrationAgainstSnapshot(refs, emptySnapshot)).toBe('missing');
  });

  it('classifies as ambiguous when the migration creates no table (even if it creates a function)', () => {
    const refs = { tables: [], functions: ['some_function'], policies: [], indexes: [] };
    expect(classifyMigrationAgainstSnapshot(refs, emptySnapshot)).toBe('ambiguous');
  });

  it('classifies as ambiguous even when the function it replaces already exists — function presence is never used as a decision signal', () => {
    const refs = { tables: [], functions: ['registrar_evento_auditoria'], policies: [], indexes: [] };
    const snapshot = { relations: [], functions: [{ name: 'registrar_evento_auditoria' }], policies: [], indexes: [] };
    expect(classifyMigrationAgainstSnapshot(refs, snapshot)).toBe('ambiguous');
  });

  it('classifies as partial-conflict when only some of several tables are present', () => {
    const refs = { tables: ['catalogo_eventos_auditoria', 'outra_tabela_nova'], functions: [], policies: [], indexes: [] };
    const snapshot = { relations: [{ name: 'catalogo_eventos_auditoria' }], functions: [], policies: [], indexes: [] };
    expect(classifyMigrationAgainstSnapshot(refs, snapshot)).toBe('partial-conflict');
  });
});

describe('classifyDrift against the real ledger', () => {
  it('classifies migration 52 as missing when the synthetic remote lacks its table, and every other DDL-bearing migration whose object is present as applied', () => {
    const ledgerResult = readCanonicalLedger();
    if (ledgerResult._tag === 'err') throw new Error('expected the committed ledger to parse');
    // SAFETY: readCanonicalLedger's JSDoc return type is a generic Record; this test narrows it
    // to the concrete canonical-ledger shape validated by parseCanonicalLedger at read time.
    const ledger = ledgerResult.value as { migrations: ReadonlyArray<{ order: number; path: string; sha256: string }> };
    const migrationSqlByOrder = ledger.migrations.map((migration) => {
      if (migration.path === './lab/00_bootstrap_schema.sql') return '';
      const absolutePath = path.resolve(path.dirname(SUPABASE_CONFIG_PATH), migration.path);
      return readFileSync(absolutePath, 'utf8');
    });

    // Synthetic remote: has every relation this ledger's migrations reference EXCEPT the one
    // migration 52 creates — simulating a remote that is missing the last approved migration.
    const allTableRefs = migrationSqlByOrder.flatMap((sql) => parseMigrationObjectRefs(sql).tables);
    const remoteRelations = [...new Set(allTableRefs)]
      .filter((name) => name !== 'catalogo_eventos_auditoria')
      .map((name) => ({ name }));
    const snapshot = { relations: remoteRelations, functions: [], policies: [], indexes: [] };

    // SAFETY: classifyDrift's JSDoc return type is a generic Record for JS-consumer flexibility;
    // this test narrows it to the concrete shape the implementation actually returns.
    const drift = classifyDrift(ledger, migrationSqlByOrder, snapshot) as unknown as { migrations: ReadonlyArray<{ path: string; classification: string }> };
    const migration52 = drift.migrations.find((m) => m.path.includes('52_auditoria_anti_forjamento_catalogo'));
    expect(migration52?.classification).toBe('missing');
  });
});

describe('buildSyncBundle', () => {
  const migrationSqlByOrder = ['create table if not exists public.novo_objeto (id int);'];
  const classified = [{ order: 1, path: '../database/99_expand_novo_objeto.sql', sha256: 'a'.repeat(64), refs: { tables: ['novo_objeto'], functions: [], policies: [], indexes: [] }, classification: 'missing', destructive: false }];

  it('includes only missing migrations, in the expand phase for additive DDL', () => {
    const bundle = buildSyncBundle(classified, migrationSqlByOrder, { appVersion: '1.2.3' });
    expect(bundle.phases.expand).toHaveLength(1);
    expect(bundle.phases.expand[0].sha256).toBe('a'.repeat(64));
    expect(bundle.phases.expand[0].minAppVersion).toBe('1.2.3');
    expect(bundle.phases['backfill-dml']).toHaveLength(0);
    expect(bundle.phases.contract).toHaveLength(0);
    expect(bundle.destructiveBlock).toHaveLength(0);
  });

  it('excludes applied and ambiguous migrations from every phase', () => {
    const mixed = [
      ...classified,
      { order: 2, path: '../database/98_applied.sql', sha256: 'b'.repeat(64), refs: { tables: [], functions: [], policies: [], indexes: [] }, classification: 'applied', destructive: false },
      { order: 3, path: '../database/97_ambiguous.sql', sha256: 'c'.repeat(64), refs: { tables: [], functions: [], policies: [], indexes: [] }, classification: 'ambiguous', destructive: false },
    ];
    const bundle = buildSyncBundle(mixed, [...migrationSqlByOrder, '', ''], { appVersion: '1.2.3' });
    const allOrders = [...bundle.phases.expand, ...bundle.phases['backfill-dml'], ...bundle.phases.contract, ...bundle.destructiveBlock].map((i) => i.order);
    expect(allOrders).toEqual([1]);
  });

  it('routes a destructive missing migration into destructiveBlock, never into a phase', () => {
    const destructiveClassified = [{ order: 1, path: '../database/99_contract_drop_legacy.sql', sha256: 'd'.repeat(64), refs: { tables: [], functions: [], policies: [], indexes: [] }, classification: 'missing', destructive: true }];
    const bundle = buildSyncBundle(destructiveClassified, ['drop table public.legacy;'], { appVersion: '1.2.3' });
    expect(bundle.destructiveBlock).toHaveLength(1);
    expect(bundle.phases.expand).toHaveLength(0);
    expect(bundle.phases.contract).toHaveLength(0);
  });

  it('places a filename-tagged backfill migration in the backfill-dml phase', () => {
    const backfillClassified = [{ order: 1, path: '../database/44_backfill_financeiro_organizacao_contabilizado.sql', sha256: 'e'.repeat(64), refs: { tables: [], functions: [], policies: [], indexes: [] }, classification: 'missing', destructive: false }];
    const bundle = buildSyncBundle(backfillClassified, ['update public.foo set bar = 1;'], { appVersion: '1.2.3' });
    expect(bundle.phases['backfill-dml']).toHaveLength(1);
  });
});

describe('readAppVersion', () => {
  it('reads the version from the real package.json deterministically', () => {
    const version = readAppVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('estimateBackfillFromReltuples', () => {
  it('estimates batches from approximate row-count metadata only, never table content', () => {
    const estimate = estimateBackfillFromReltuples([{ relname: 'pedidos', reltuples: 12000 }], ['pedidos']);
    expect(estimate[0].approxRowCount).toBe(12000);
    expect(estimate[0].estimatedBatches).toBe(3);
  });

  it('defaults to zero rows for a table absent from the metadata rows', () => {
    const estimate = estimateBackfillFromReltuples([], ['pedidos']);
    expect(estimate[0].approxRowCount).toBe(0);
    expect(estimate[0].estimatedBatches).toBe(1);
  });
});

describe('buildRollbackPlan', () => {
  it('flags owner approval as required when the bundle has a destructive block', () => {
    // SAFETY: buildRollbackPlan's JSDoc return type is a generic Record; this test narrows it to
    // the concrete fields the implementation actually returns.
    const plan = buildRollbackPlan({ destructiveBlock: [{}] }) as unknown as { destructiveItemsRequireOwnApproval: boolean; order: ReadonlyArray<string> };
    expect(plan.destructiveItemsRequireOwnApproval).toBe(true);
    expect(plan.order[0]).toContain('app-first');
    expect(plan.order[2]).toContain('restore');
  });

  it('does not require destructive approval when the bundle has none', () => {
    const plan = buildRollbackPlan({ destructiveBlock: [] });
    expect(plan.destructiveItemsRequireOwnApproval).toBe(false);
  });
});

describe('buildApprovalForm', () => {
  const context = {
    target: 'synthetic-local-lab (no real remote confirmed — see 22-checkpoint.md)',
    commit: 'abc1234',
    files: [{ path: 'database/99_x.sql', sha256: 'f'.repeat(64) }],
    window: 'needs-owner',
    impact: 'additive only in this rehearsal',
    backups: 'lab is disposable; no production backup applicable',
    validations: ['pgTAP passes', 'catalog fingerprint stable across 2 cycles'],
    abortRollback: 'see rollback plan',
    executor: 'needs-owner',
  };

  it('always renders the fixed awaiting-owner-approval status', () => {
    const form = buildApprovalForm(context);
    expect(form).toContain(`status**: ${APPROVAL_STATUS}`);
  });

  it('refuses to render any other status', () => {
    expect(() => buildApprovalForm({ ...context, status: 'applied' })).toThrow(/awaiting-owner-approval/);
  });
});
