import fs from 'node:fs';
import path from 'node:path';

import { DATABASE_DIRECTORY, readCanonicalLedger, SUPABASE_CONFIG_PATH } from './database-ledger.mjs';
import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

const TEST_DIRECTORY = path.resolve(process.cwd(), 'supabase', 'tests', 'database');

/**
 * Expand checksum-locked migration includes into a pgTAP test in memory.
 *
 * @param {object} options - Test path, allowlist and filesystem boundary.
 * @returns {{ readonly _tag: 'ok', readonly value: string } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Expanded SQL or a tagged include failure.
 */
export function expandCanonicalIncludes({ testPath, allowedMigrations, fileSystem = fs }) {
  try {
    const source = fileSystem.readFileSync(testPath, 'utf8').replace(/^\uFEFF/, '');
    let includeFailure;
    const expanded = source.replace(/^\\ir\s+(.+)$/gm, (_line, includePath) => {
      const resolvedPath = path.resolve(path.dirname(testPath), includePath.trim());
      if (!allowedMigrations.has(resolvedPath)) {
        includeFailure = err(
          'PgTapIncludeRejected',
          `${includePath} is not present in the checksum-locked production migration set`,
          { testName: path.basename(testPath), includePath },
        );
        return '';
      }
      return fileSystem.readFileSync(resolvedPath, 'utf8').replace(/^\uFEFF/, '');
    });
    return includeFailure ?? ok(expanded);
  } catch (cause) {
    return err('PgTapReadFailed', `Could not expand pgTAP test ${path.basename(testPath)}`, { testName: path.basename(testPath) }, cause);
  }
}

/**
 * Parse PostgreSQL query output as a complete pgTAP plan.
 *
 * @param {unknown} queryResults - Raw node-postgres query result or result list.
 * @param {string} testName - Safe test filename for diagnostics.
 * @returns {{ readonly _tag: 'ok', readonly value: { readonly planned: number, readonly passed: number } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Parsed assertions or a tagged pgTAP failure.
 */
export function parsePgTapResults(queryResults, testName) {
  const results = Array.isArray(queryResults) ? queryResults : [queryResults];
  const tapLines = results.flatMap((result) => result?.rows ?? [])
    .flatMap((row) => Object.values(row))
    .filter((value) => typeof value === 'string');
  const plan = tapLines.map((line) => line.match(/^1\.\.(\d+)$/)).find(Boolean);
  if (!plan) return err('PgTapPlanMissing', `${testName}: pgTAP plan was not emitted`, { testName });
  const assertions = tapLines.filter((line) => /^(?:not )?ok\s+\d+/.test(line));
  const failed = assertions.filter((line) => line.startsWith('not ok'));
  if (failed.length > 0) {
    return err('PgTapAssertionFailed', `${testName}: ${failed.join(' | ')}`, { testName, failedAssertions: failed.length });
  }
  const planned = Number(plan[1]);
  if (assertions.length !== planned) {
    return err(
      'PgTapPlanMismatch',
      `${testName}: planned ${planned} assertions but emitted ${assertions.length}`,
      { testName, planned, emitted: assertions.length },
    );
  }
  return ok(Object.freeze({ planned, passed: assertions.length }));
}

/**
 * Run all historical migration pgTAP tests against the disposable local database.
 *
 * @param {object} [options] - Injected database, ledger and filesystem boundaries.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: { readonly files: number, readonly assertions: number } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Test evidence or a tagged database/test failure.
 */
export async function runMigrationPgTapTests({
  client = createLocalDatabaseClient('orbita-database-pgtap'),
  ledgerResult = readCanonicalLedger(),
  testDirectory = TEST_DIRECTORY,
  fileSystem = fs,
} = {}) {
  if (ledgerResult._tag === 'err') return ledgerResult;
  const allowedMigrations = new Set(ledgerResult.value.migrations
    .map((migration) => path.resolve(path.dirname(SUPABASE_CONFIG_PATH), migration.path))
    .filter((migrationPath) => migrationPath.startsWith(`${DATABASE_DIRECTORY}${path.sep}`)));
  let testPaths;
  try {
    testPaths = fileSystem.readdirSync(testDirectory)
      .filter((fileName) => fileName.endsWith('.test.sql'))
      .sort()
      .map((fileName) => path.resolve(testDirectory, fileName));
  } catch (cause) {
    return err('PgTapReadFailed', `Could not enumerate pgTAP tests: ${testDirectory}`, { testDirectory }, cause);
  }

  let outcome = ok(Object.freeze({ files: testPaths.length, assertions: 0 }));
  let activeTestName = 'pgTAP setup';
  try {
    await client.connect();
    await client.query('create extension if not exists pgtap with schema extensions');
    await client.query('set search_path = extensions, public');
    let assertions = 0;
    for (const testPath of testPaths) {
      activeTestName = path.basename(testPath);
      const expanded = expandCanonicalIncludes({ testPath, allowedMigrations, fileSystem });
      if (expanded._tag === 'err') {
        outcome = expanded;
        break;
      }
      const parsed = parsePgTapResults(await client.query(expanded.value), path.basename(testPath));
      if (parsed._tag === 'err') {
        outcome = parsed;
        break;
      }
      assertions += parsed.value.passed;
      console.log(`[database-lab] pgTAP ${path.basename(testPath)}: ${parsed.value.passed} passed`);
      outcome = ok(Object.freeze({ files: testPaths.length, assertions }));
    }
  } catch (cause) {
    const databaseCode = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : 'unknown';
    outcome = err(
      'PgTapDatabaseFailed',
      `Could not execute ${activeTestName} in the local database (PostgreSQL ${databaseCode})`,
      { testName: activeTestName, databaseCode },
      cause,
    );
  } finally {
    try {
      await client.end();
    } catch (cause) {
      if (outcome._tag === 'ok') outcome = err('PgTapCleanupFailed', 'Could not close the local pgTAP database client', {}, cause);
    }
  }
  return outcome;
}
