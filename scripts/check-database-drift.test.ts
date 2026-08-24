import { describe, expect, it } from 'vitest';
import { checkDatabaseDrift } from './check-database-drift.mjs';

describe('checkDatabaseDrift script', () => {
  it('passes on canonical repository database configuration', () => {
    const result = checkDatabaseDrift();
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
    expect(result.checkedFiles).toBe(result.registeredFiles);
  });

  it('detects untracked migration files in database/ directory', () => {
    const mockFs = {
      existsSync: () => true,
      readdirSync: () => ['schema_master.sql', '03_update_pedidos_status.sql', '99_rogue_migration.sql'],
      readFileSync: () => `
        [db.migrations]
        schema_paths = [
          "../database/schema_master.sql",
          "../database/03_update_pedidos_status.sql"
        ]
      `,
    };

    const result = checkDatabaseDrift({
      // @ts-expect-error mock filesystem
      fileSystem: mockFs,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e: string) => e.includes('99_rogue_migration.sql'))).toBe(true);
  });

  it('detects registered migrations that do not exist on disk', () => {
    const mockFs = {
      existsSync: (p: string) => !p.includes('missing_migration.sql'),
      readdirSync: () => ['schema_master.sql'],
      readFileSync: () => `
        [db.migrations]
        schema_paths = [
          "../database/schema_master.sql",
          "../database/missing_migration.sql"
        ]
      `,
    };

    const result = checkDatabaseDrift({
      // @ts-expect-error mock filesystem
      fileSystem: mockFs,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e: string) => e.includes('missing_migration.sql'))).toBe(true);
  });

  it('fails if initial schema is not first in ledger', () => {
    const mockFs = {
      existsSync: () => true,
      readdirSync: () => ['03_update_pedidos_status.sql', 'schema_master.sql'],
      readFileSync: () => `
        [db.migrations]
        schema_paths = [
          "../database/03_update_pedidos_status.sql",
          "../database/schema_master.sql"
        ]
      `,
    };

    const result = checkDatabaseDrift({
      // @ts-expect-error mock filesystem
      fileSystem: mockFs,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e: string) => e.includes('Initial schema must be the first'))).toBe(true);
  });
});
