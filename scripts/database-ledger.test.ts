import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCanonicalLedger,
  parseSchemaPaths,
  readCanonicalLedger,
  validateCanonicalLedger,
} from './database-ledger.mjs';

const config = `
  [db.migrations]
  schema_paths = [
    "./lab/00_bootstrap_schema.sql",
    "../database/07_alpha.sql",
    "../database/07_beta.sql"
  ]
`;

const sqlContents: Readonly<Record<string, string>> = {
  '00_bootstrap_schema.sql': 'create table public.root(id bigint);',
  '07_alpha.sql': 'select 1;',
  '07_beta.sql': 'select 2;',
  'schema_master.sql': 'legacy reference',
};

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureValue(filePath: string) {
  const value = sqlContents[path.basename(filePath)];
  if (value === undefined) throw new Error(`missing fixture: ${filePath}`);
  return value;
}

describe('canonical database ledger', () => {
  it('parses the declared order without sorting duplicate numeric prefixes', () => {
    expect(parseSchemaPaths(config)).toEqual({
      _tag: 'ok',
      value: ['./lab/00_bootstrap_schema.sql', '../database/07_alpha.sql', '../database/07_beta.sql'],
    });
  });

  it('locks executable SQL and the immutable legacy reference independently', () => {
    const fileSystem = { readFileSync: fixtureValue };
    const result = buildCanonicalLedger({
      configContent: config,
      configPath: path.resolve('supabase/config.toml'),
      fileSystem,
    });

    expect(result).toEqual({
      _tag: 'ok',
      value: {
        version: 2,
        migrations: [
          { order: 1, path: './lab/00_bootstrap_schema.sql', sha256: digest(sqlContents['00_bootstrap_schema.sql'] ?? '') },
          { order: 2, path: '../database/07_alpha.sql', sha256: digest(sqlContents['07_alpha.sql'] ?? '') },
          { order: 3, path: '../database/07_beta.sql', sha256: digest(sqlContents['07_beta.sql'] ?? '') },
        ],
        references: [{ path: '../database/schema_master.sql', sha256: digest(sqlContents['schema_master.sql'] ?? '') }],
        duplicatePrefixes: { '07': ['07_alpha.sql', '07_beta.sql'] },
      },
    });
  });

  it('rejects a changed reference even when executable migrations still match', () => {
    const current = buildCanonicalLedger({
      configContent: config,
      configPath: path.resolve('supabase/config.toml'),
      fileSystem: { readFileSync: fixtureValue },
    });
    if (current._tag === 'err') throw new Error(String(current.error.message));
    const expected = {
      ...current.value,
      references: [{ path: '../database/schema_master.sql', sha256: digest('mutated reference') }],
    };
    const fileSystem = {
      existsSync: () => true,
      readdirSync(directory: string) {
        return path.basename(directory) === 'lab'
          ? ['00_bootstrap_schema.sql']
          : ['07_alpha.sql', '07_beta.sql', 'schema_master.sql'];
      },
      readFileSync(filePath: string) {
        if (filePath.endsWith('.json')) return JSON.stringify(expected);
        if (filePath.endsWith('.toml')) return config;
        return fixtureValue(filePath);
      },
    };

    const result = validateCanonicalLedger({
      databaseDir: path.resolve('database'),
      labDir: path.resolve('supabase/lab'),
      configPath: path.resolve('supabase/config.toml'),
      ledgerPath: path.resolve('database/migrations.lock.json'),
      fileSystem,
    });

    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error.message).toContain('reference SQL checksum differs');
  });

  it('rejects untracked SQL in either production history or laboratory support', () => {
    const current = buildCanonicalLedger({
      configContent: config,
      configPath: path.resolve('supabase/config.toml'),
      fileSystem: { readFileSync: fixtureValue },
    });
    if (current._tag === 'err') throw new Error(String(current.error.message));
    const fileSystem = {
      existsSync: () => true,
      readdirSync(directory: string) {
        return path.basename(directory) === 'lab'
          ? ['00_bootstrap_schema.sql', 'untracked-lab.sql']
          : ['07_alpha.sql', '07_beta.sql', 'schema_master.sql', 'untracked-production.sql'];
      },
      readFileSync(filePath: string) {
        if (filePath.endsWith('.json')) return JSON.stringify(current.value);
        if (filePath.endsWith('.toml')) return config;
        return fixtureValue(filePath);
      },
    };

    const result = validateCanonicalLedger({
      databaseDir: path.resolve('database'),
      labDir: path.resolve('supabase/lab'),
      configPath: path.resolve('supabase/config.toml'),
      ledgerPath: path.resolve('database/migrations.lock.json'),
      fileSystem,
    });

    expect(result._tag).toBe('err');
    if (result._tag === 'err') {
      expect(result.error.message).toContain('untracked-lab.sql');
      expect(result.error.message).toContain('untracked-production.sql');
    }
  });

  it('rejects syntactically valid JSON that does not match the versioned ledger contract', () => {
    const result = readCanonicalLedger({
      ledgerPath: path.resolve('database/migrations.lock.json'),
      fileSystem: { readFileSync: () => '{}' },
    });

    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error._tag).toBe('LedgerFormatInvalid');
  });
});
