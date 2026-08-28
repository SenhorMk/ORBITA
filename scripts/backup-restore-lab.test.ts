import { describe, expect, it } from 'vitest';
import {
  assertLocalOnlyTarget,
  buildPgDumpPublicArgs,
  buildPgDumpAuthUsersArgs,
  buildPgRestorePublicArgs,
  buildPgRestoreAuthUsersArgs,
  buildStartRestoreTargetArgs,
  buildRemoveRestoreTargetArgs,
  diffFingerprints,
  captureSchemaFingerprint,
  RESTORE_CONTAINER_NAME,
  RESTORE_PORT,
  SOURCE_PORT,
} from './backup-restore-lab.mjs';

describe('assertLocalOnlyTarget', () => {
  it('accepts the two disposable local instances this lab owns', () => {
    expect(assertLocalOnlyTarget('127.0.0.1', SOURCE_PORT)._tag).toBe('ok');
    expect(assertLocalOnlyTarget('host.docker.internal', RESTORE_PORT)._tag).toBe('ok');
  });

  it('refuses a remote/shared host even if the port matches', () => {
    const result = assertLocalOnlyTarget('db.supabase.co', SOURCE_PORT);
    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error._tag).toBe('UnsafeBackupRestoreTarget');
  });

  it('refuses a port outside the disposable lab pair even on localhost', () => {
    const result = assertLocalOnlyTarget('127.0.0.1', 5432);
    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error._tag).toBe('UnsafeBackupRestoreTarget');
  });
});

describe('command builders never use a shell and stay within the local lab pair', () => {
  it('builds a public-schema pg_dump argv targeting only the source lab port', () => {
    const args = buildPgDumpPublicArgs({ hostDumpDir: '/tmp/dump', dumpFileName: 'public.dump' });
    expect(args).toContain('pg_dump');
    expect(args).toContain(String(SOURCE_PORT));
    expect(args).toContain('public');
    expect(args.join(' ')).not.toMatch(/&&|;|\|/); // no shell metacharacters possible: argv array
  });

  it('builds an auth.users data-only pg_dump argv targeting only the source lab port', () => {
    const args = buildPgDumpAuthUsersArgs({ hostDumpDir: '/tmp/dump', dumpFileName: 'auth.dump' });
    expect(args).toContain('--data-only');
    expect(args).toContain('auth.users');
    expect(args).toContain(String(SOURCE_PORT));
  });

  it('builds a public-schema pg_restore argv targeting only the restore target port, without --clean (target starts empty)', () => {
    const args = buildPgRestorePublicArgs({ hostDumpDir: '/tmp/dump', dumpFileName: 'public.dump' });
    expect(args).toContain('pg_restore');
    expect(args).toContain(String(RESTORE_PORT));
    expect(args).not.toContain('--clean');
  });

  it('builds an auth.users data-only pg_restore argv targeting only the restore target port', () => {
    const args = buildPgRestoreAuthUsersArgs({ hostDumpDir: '/tmp/dump', dumpFileName: 'auth.dump' });
    expect(args).toContain('--data-only');
    expect(args).toContain(String(RESTORE_PORT));
  });

  it('builds a start command naming only the dedicated restore container', () => {
    const args = buildStartRestoreTargetArgs();
    expect(args).toContain(RESTORE_CONTAINER_NAME);
    expect(args).toContain(`${RESTORE_PORT}:5432`);
  });

  it('builds a removal command that only ever targets the dedicated restore container', () => {
    const args = buildRemoveRestoreTargetArgs();
    expect(args).toEqual(['rm', '-f', RESTORE_CONTAINER_NAME]);
  });
});

describe('diffFingerprints', () => {
  it('reports no differences when source and target fingerprints match exactly', () => {
    const fp = {
      tables: [{ table: 'organizacoes', count: 3, checksum: 'abc' }],
      constraintsByType: [{ constraint_type: 'PRIMARY KEY', count: 1 }],
      policyCount: 2,
      rlsEnabledTableCount: 1,
      functionCount: 4,
      indexCount: 5,
    };
    expect(diffFingerprints(fp, fp)).toEqual([]);
  });

  it('reports a row-count mismatch after a corrupted restore', () => {
    const source = {
      tables: [{ table: 'organizacoes', count: 3, checksum: 'abc' }],
      constraintsByType: [],
      policyCount: 0,
      rlsEnabledTableCount: 0,
      functionCount: 0,
      indexCount: 0,
    };
    const target = { ...source, tables: [{ table: 'organizacoes', count: 2, checksum: 'abc' }] };
    const errors = diffFingerprints(source, target);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('row count differs')]));
  });

  it('reports a checksum mismatch even when counts match (silent corruption)', () => {
    const source = {
      tables: [{ table: 'organizacoes', count: 3, checksum: 'abc' }],
      constraintsByType: [],
      policyCount: 0,
      rlsEnabledTableCount: 0,
      functionCount: 0,
      indexCount: 0,
    };
    const target = { ...source, tables: [{ table: 'organizacoes', count: 3, checksum: 'zzz' }] };
    const errors = diffFingerprints(source, target);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('checksum differs')]));
  });

  it('reports a missing table after restore', () => {
    const source = {
      tables: [{ table: 'organizacoes', count: 3, checksum: 'abc' }, { table: 'membros_organizacao', count: 1, checksum: 'x' }],
      constraintsByType: [],
      policyCount: 0,
      rlsEnabledTableCount: 0,
      functionCount: 0,
      indexCount: 0,
    };
    const target = { ...source, tables: [{ table: 'organizacoes', count: 3, checksum: 'abc' }] };
    const errors = diffFingerprints(source, target);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('table missing after restore: membros_organizacao')]));
  });

  it('reports RLS policy count drift', () => {
    const source = {
      tables: [],
      constraintsByType: [],
      policyCount: 3,
      rlsEnabledTableCount: 2,
      functionCount: 0,
      indexCount: 0,
    };
    const target = { ...source, policyCount: 1 };
    const errors = diffFingerprints(source, target);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('RLS policy count differs')]));
  });
});

describe('captureSchemaFingerprint', () => {
  it('aggregates per-table counts/checksums and catalog counts from an injected client', async () => {
    const queries: string[] = [];
    const fakeClient = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('information_schema.tables')) return { rows: [{ table_name: 'organizacoes' }] };
        if (sql.includes('count(*)::bigint')) return { rows: [{ count: '5' }] };
        if (sql.includes('row_hash')) return { rows: [{ checksum: 'deadbeef' }] };
        if (sql.includes('table_constraints')) return { rows: [{ constraint_type: 'PRIMARY KEY', count: 1 }] };
        if (sql.includes('pg_policies')) return { rows: [{ count: 2 }] };
        if (sql.includes('rowsecurity')) return { rows: [{ count: 1 }] };
        if (sql.includes('routines')) return { rows: [{ count: 3 }] };
        if (sql.includes('pg_indexes')) return { rows: [{ count: 4 }] };
        throw new Error(`unexpected query in fake client: ${sql}`);
      },
    };
    const fingerprint = await captureSchemaFingerprint(fakeClient);
    expect(fingerprint.tables).toEqual([{ table: 'organizacoes', count: 5, checksum: 'deadbeef' }]);
    expect(fingerprint.policyCount).toBe(2);
    expect(fingerprint.rlsEnabledTableCount).toBe(1);
    expect(fingerprint.functionCount).toBe(3);
    expect(fingerprint.indexCount).toBe(4);
  });
});
