import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { expandCanonicalIncludes, parsePgTapResults } from './database-pgtap.mjs';

describe('database pgTAP runner', () => {
  it('expands a checksum-ledger migration directly in memory', () => {
    const testPath = path.resolve('supabase/tests/database/example.test.sql');
    const migrationPath = path.resolve('database/20_example.sql');
    const fileSystem = {
      readFileSync(filePath: string) {
        if (filePath === testPath) return 'begin;\n\\ir ../../../database/20_example.sql\nrollback;';
        if (filePath === migrationPath) return 'select 20;';
        throw new Error(`unexpected path ${filePath}`);
      },
    };

    expect(expandCanonicalIncludes({
      testPath,
      allowedMigrations: new Set([migrationPath]),
      fileSystem,
    })).toEqual({ _tag: 'ok', value: 'begin;\nselect 20;\nrollback;' });
  });

  it('rejects includes outside the checksum-locked migration set', () => {
    const testPath = path.resolve('supabase/tests/database/example.test.sql');
    const fileSystem = {
      readFileSync: () => 'begin;\n\\ir ../../../database/untracked.sql\nrollback;',
    };

    const result = expandCanonicalIncludes({
      testPath,
      allowedMigrations: new Set(),
      fileSystem,
    });
    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error.message).toContain('not present in the checksum-locked');
  });

  it('fails on a real pgTAP not-ok result and validates the plan count', () => {
    const failed = parsePgTapResults([
      { rows: [{ plan: '1..2' }] },
      { rows: [{ ok: 'ok 1 - first invariant' }] },
      { rows: [{ ok: 'not ok 2 - leaked grant' }] },
    ], 'catalog.test.sql');
    expect(failed._tag).toBe('err');
    if (failed._tag === 'err') expect(failed.error.message).toContain('not ok 2 - leaked grant');

    expect(parsePgTapResults([
      { rows: [{ plan: '1..2' }] },
      { rows: [{ ok: 'ok 1 - first invariant' }] },
      { rows: [{ ok: 'ok 2 - second invariant' }] },
    ], 'catalog.test.sql')).toEqual({ _tag: 'ok', value: { planned: 2, passed: 2 } });
  });
});
