import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { err, failureMessage, ok } from './script-result.mjs';

/** Directory containing production migration history and immutable references. */
export const DATABASE_DIRECTORY = path.resolve(process.cwd(), 'database');

/** Directory containing SQL support files used only by the disposable laboratory. */
export const DATABASE_LAB_DIRECTORY = path.resolve(process.cwd(), 'supabase', 'lab');

/** Supabase configuration that declares the laboratory execution order. */
export const SUPABASE_CONFIG_PATH = path.resolve(process.cwd(), 'supabase', 'config.toml');

/** Checksum ledger for executable SQL and immutable reference SQL. */
export const DATABASE_LEDGER_PATH = path.resolve(DATABASE_DIRECTORY, 'migrations.lock.json');

const REFERENCE_PATHS = Object.freeze(['../database/schema_master.sql']);

/**
 * Parse the ordered SQL paths from a Supabase configuration.
 *
 * @param {string} configContent - Raw `supabase/config.toml` content.
 * @returns {{ readonly _tag: 'ok', readonly value: ReadonlyArray<string> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Parsed paths or a tagged configuration failure.
 */
export function parseSchemaPaths(configContent) {
  const match = configContent.match(/schema_paths\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return err('LedgerConfigInvalid', 'schema_paths configuration block not found in supabase/config.toml');
  const schemaPaths = [...match[1].matchAll(/"([^"]+\.sql)"/g)].map((entry) => entry[1]);
  if (schemaPaths.length === 0) return err('LedgerConfigInvalid', 'schema_paths does not declare any SQL files');
  return ok(Object.freeze(schemaPaths));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isChecksum(value) {
  return typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
}

function isLockedEntry(value) {
  return isRecord(value) && typeof value.path === 'string' && isChecksum(value.sha256);
}

/**
 * Parse unknown JSON into the supported canonical ledger format.
 *
 * @param {unknown} input - Value returned by `JSON.parse` or another boundary.
 * @returns {{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Parsed ledger or a tagged format failure.
 */
export function parseCanonicalLedger(input) {
  if (!isRecord(input) || input.version !== 2) {
    return err('LedgerFormatInvalid', 'Canonical migration ledger must be a version 2 object');
  }
  if (!Array.isArray(input.migrations) || input.migrations.length === 0) {
    return err('LedgerFormatInvalid', 'Canonical migration ledger must contain executable migrations');
  }
  const migrationsValid = input.migrations.every((migration, index) => (
    isLockedEntry(migration)
    && Number.isInteger(migration.order)
    && migration.order === index + 1
  ));
  if (!migrationsValid) {
    return err('LedgerFormatInvalid', 'Canonical migration entries require sequential order, path, and SHA-256 checksum');
  }
  if (!Array.isArray(input.references) || !input.references.every(isLockedEntry)) {
    return err('LedgerFormatInvalid', 'Canonical ledger references require path and SHA-256 checksum');
  }
  if (!isRecord(input.duplicatePrefixes) || !Object.values(input.duplicatePrefixes).every((files) => (
    Array.isArray(files) && files.every((fileName) => typeof fileName === 'string')
  ))) {
    return err('LedgerFormatInvalid', 'Canonical ledger duplicatePrefixes must map prefixes to filenames');
  }
  const allPaths = [...input.migrations, ...input.references].map((entry) => entry.path);
  if (new Set(allPaths).size !== allPaths.length) {
    return err('LedgerFormatInvalid', 'Canonical migration ledger contains duplicate SQL paths');
  }
  return ok(Object.freeze(input));
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function duplicatePrefixes(migrations) {
  const groups = new Map();
  for (const migration of migrations) {
    const fileName = path.basename(migration.path);
    const match = fileName.match(/^(\d+)_/);
    if (!match) continue;
    const files = groups.get(match[1]) ?? [];
    files.push(fileName);
    groups.set(match[1], files);
  }
  return Object.fromEntries([...groups].filter(([, files]) => files.length > 1));
}

function lockedEntry(configPath, declaredPath, fileSystem) {
  const absolutePath = path.resolve(path.dirname(configPath), declaredPath);
  return {
    path: declaredPath.replaceAll('\\', '/'),
    sha256: sha256(fileSystem.readFileSync(absolutePath)),
  };
}

/**
 * Build the canonical execution and reference ledger from files on disk.
 *
 * @param {object} [options] - Filesystem and path overrides used by tests.
 * @returns {{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Built ledger or a tagged filesystem/configuration failure.
 */
export function buildCanonicalLedger({
  configContent,
  configPath = SUPABASE_CONFIG_PATH,
  referencePaths = REFERENCE_PATHS,
  fileSystem = fs,
} = {}) {
  try {
    const resolvedConfig = configContent ?? fileSystem.readFileSync(configPath, 'utf8');
    const parsedPaths = parseSchemaPaths(resolvedConfig);
    if (parsedPaths._tag === 'err') return parsedPaths;
    const migrations = parsedPaths.value.map((migrationPath, index) => ({
      order: index + 1,
      ...lockedEntry(configPath, migrationPath, fileSystem),
    }));
    const references = referencePaths.map((referencePath) => lockedEntry(configPath, referencePath, fileSystem));
    return ok(Object.freeze({
      version: 2,
      migrations: Object.freeze(migrations),
      references: Object.freeze(references),
      duplicatePrefixes: Object.freeze(duplicatePrefixes(migrations)),
    }));
  } catch (cause) {
    return err('LedgerReadFailed', 'Could not read SQL inputs for the canonical migration ledger', {}, cause);
  }
}

/**
 * Read and parse the committed canonical ledger.
 *
 * @param {object} [options] - Filesystem and path overrides used by tests.
 * @returns {{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Parsed ledger or a tagged read failure.
 */
export function readCanonicalLedger({ ledgerPath = DATABASE_LEDGER_PATH, fileSystem = fs } = {}) {
  try {
    return parseCanonicalLedger(JSON.parse(fileSystem.readFileSync(ledgerPath, 'utf8')));
  } catch (cause) {
    return err('LedgerReadFailed', `Could not read canonical migration ledger: ${ledgerPath}`, { ledgerPath }, cause);
  }
}

function findUntrackedSql({ directory, trackedAbsolutePaths, fileSystem }) {
  if (!fileSystem.existsSync(directory)) return [`SQL directory does not exist: ${directory}`];
  return fileSystem.readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .map((fileName) => path.resolve(directory, fileName))
    .filter((absolutePath) => !trackedAbsolutePaths.has(absolutePath))
    .map((absolutePath) => `untracked SQL file: ${path.relative(process.cwd(), absolutePath).replaceAll('\\', '/')}`);
}

/**
 * Compare the committed ledger with the configured order and all tracked SQL files.
 *
 * @param {object} [options] - Filesystem and path overrides used by tests.
 * @returns {{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Validation evidence or a tagged drift failure.
 */
export function validateCanonicalLedger({
  databaseDir = DATABASE_DIRECTORY,
  labDir = DATABASE_LAB_DIRECTORY,
  configPath = SUPABASE_CONFIG_PATH,
  ledgerPath = DATABASE_LEDGER_PATH,
  referencePaths = REFERENCE_PATHS,
  fileSystem = fs,
} = {}) {
  const missingInputs = [
    ['Database directory', databaseDir],
    ['Database lab directory', labDir],
    ['Supabase config.toml', configPath],
    ['Migration ledger', ledgerPath],
  ].filter(([, target]) => !fileSystem.existsSync(target));
  if (missingInputs.length > 0) {
    return err('LedgerInputMissing', missingInputs.map(([label, target]) => `${label} does not exist: ${target}`).join('\n'));
  }

  const actualResult = buildCanonicalLedger({ configPath, referencePaths, fileSystem });
  if (actualResult._tag === 'err') return actualResult;
  const expectedResult = readCanonicalLedger({ ledgerPath, fileSystem });
  if (expectedResult._tag === 'err') return expectedResult;
  const actual = actualResult.value;
  const expected = expectedResult.value;
  const errors = [];

  if (expected.version !== 2) errors.push(`unsupported migration ledger version: ${expected.version}`);
  const trackedPaths = [...actual.migrations, ...actual.references]
    .map((entry) => path.resolve(path.dirname(configPath), entry.path));
  const trackedAbsolutePaths = new Set(trackedPaths);
  errors.push(...findUntrackedSql({ directory: databaseDir, trackedAbsolutePaths, fileSystem }));
  errors.push(...findUntrackedSql({ directory: labDir, trackedAbsolutePaths, fileSystem }));
  if (actual.migrations[0]?.path !== './lab/00_bootstrap_schema.sql') {
    errors.push(`laboratory bootstrap must be first, found: ${actual.migrations[0]?.path ?? 'none'}`);
  }
  if (JSON.stringify(expected.migrations) !== JSON.stringify(actual.migrations)) {
    errors.push('migration order or checksum differs from the committed ledger');
  }
  if (JSON.stringify(expected.references) !== JSON.stringify(actual.references)) {
    errors.push('reference SQL checksum differs from the committed ledger');
  }
  if (JSON.stringify(expected.duplicatePrefixes) !== JSON.stringify(actual.duplicatePrefixes)) {
    errors.push('duplicate prefix declaration mismatch');
  }
  if (errors.length > 0) return err('DatabaseDriftDetected', errors.join('\n'), { errors: Object.freeze(errors) });
  return ok(Object.freeze({
    checkedFiles: trackedPaths.length,
    registeredMigrations: actual.migrations.length,
    ledger: actual,
  }));
}

/**
 * Regenerate the committed ledger after deliberate review of the new order.
 *
 * @param {object} [options] - Filesystem and path overrides used by tests.
 * @returns {{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Written ledger or a tagged write failure.
 */
export function writeCanonicalLedger({ ledgerPath = DATABASE_LEDGER_PATH, fileSystem = fs } = {}) {
  const ledgerResult = buildCanonicalLedger({ fileSystem });
  if (ledgerResult._tag === 'err') return ledgerResult;
  try {
    fileSystem.writeFileSync(ledgerPath, `${JSON.stringify(ledgerResult.value, null, 2)}\n`, 'utf8');
    return ledgerResult;
  } catch (cause) {
    return err('LedgerWriteFailed', `Could not write canonical migration ledger: ${ledgerPath}`, { ledgerPath }, cause);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/database-ledger.mjs')) {
  if (!process.argv.includes('--write')) {
    console.error('Use --write to deliberately regenerate database/migrations.lock.json.');
    process.exitCode = 1;
  } else {
    const result = writeCanonicalLedger();
    if (result._tag === 'err') {
      console.error(failureMessage(result.error));
      process.exitCode = 1;
    } else {
      console.log(`Wrote canonical ledger for ${result.value.migrations.length} migrations and ${result.value.references.length} references.`);
    }
  }
}
