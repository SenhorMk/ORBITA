import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateCanonicalLedger } from './database-ledger.mjs';

describe('checkDatabaseDrift script', () => {
  it('passes on the checksum-locked canonical repository ledger', () => {
    const result = validateCanonicalLedger();
    expect(result._tag).toBe('ok');
    if (result._tag === 'ok') {
      expect(result.value.checkedFiles).toBe(87);
      expect(result.value.registeredMigrations).toBe(86);
    }
  });

  it('fails when the locked checksum differs from canonical SQL', () => {
    const config = '[db.migrations]\nschema_paths = ["./lab/00_bootstrap.sql"]';
    const ledger = {
      version: 2,
      migrations: [{ order: 1, path: './lab/00_bootstrap.sql', sha256: '0'.repeat(64) }],
      references: [{ path: '../database/schema_master.sql', sha256: '0'.repeat(64) }],
      duplicatePrefixes: {},
    };
    const fileSystem = {
      existsSync: () => true,
      readdirSync(directory: string) {
        return path.basename(directory) === 'lab' ? ['00_bootstrap.sql'] : ['schema_master.sql'];
      },
      readFileSync(filePath: string) {
        if (filePath.endsWith('.toml')) return config;
        if (filePath.endsWith('.json')) return JSON.stringify(ledger);
        return 'select 1;';
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
    if (result._tag === 'err') expect(result.error.message).toContain('differs from the committed ledger');
  });
});
