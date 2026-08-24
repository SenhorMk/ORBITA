import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, failureMessage, ok } from './script-result.mjs';

/** Committed fingerprint and object counts for the expected final database catalog. */
export const CATALOG_REFERENCE_PATH = path.resolve(process.cwd(), 'database', 'catalog-reference.json');

const CATALOG_QUERIES = Object.freeze({
  relations: `
    select c.relname as name, c.relkind as kind, r.rolname as owner,
           c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
           coalesce(c.relacl::text, '') as acl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
    order by c.relkind, c.relname`,
  columns: `
    select table_name, ordinal_position, column_name, data_type, udt_name,
           is_nullable, coalesce(column_default, '') as column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position`,
  policies: `
    select tablename, policyname, permissive, roles::text, cmd,
           coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
    from pg_policies
    where schemaname = 'public'
    order by tablename, policyname`,
  functions: `
    select p.proname as name,
           pg_get_function_identity_arguments(p.oid) as arguments,
           pg_get_function_result(p.oid) as result,
           r.rolname as owner, p.prosecdef as security_definer,
           p.provolatile as volatility, coalesce(p.proconfig::text, '') as config,
           coalesce(p.proacl::text, '') as acl,
           pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
    order by p.proname, pg_get_function_identity_arguments(p.oid)`,
  constraints: `
    select c.relname as table_name, con.conname as name, con.contype as type,
           pg_get_constraintdef(con.oid, true) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    order by c.relname, con.conname`,
  indexes: `
    select tablename, indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
    order by tablename, indexname`,
  triggers: `
    select c.relname as table_name, t.tgname as name, pg_get_triggerdef(t.oid, true) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    order by c.relname, t.tgname`,
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

/**
 * Produce a deterministic SHA-256 fingerprint for a database catalog snapshot.
 *
 * @param {unknown} snapshot - Catalog snapshot.
 * @returns {string} Lowercase SHA-256 digest.
 */
export function catalogFingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify(stableValue(snapshot))).digest('hex');
}

/**
 * Capture the security- and structure-relevant local PostgreSQL catalog.
 *
 * @param {object} [options] - Injected local database client.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Catalog capture or a tagged database failure.
 */
export async function captureDatabaseCatalog({ client = createLocalDatabaseClient('orbita-database-catalog') } = {}) {
  const snapshot = {};
  let outcome;
  try {
    await client.connect();
    for (const [name, query] of Object.entries(CATALOG_QUERIES)) {
      snapshot[name] = (await client.query(query)).rows;
    }
    outcome = ok(Object.freeze({
      fingerprint: catalogFingerprint(snapshot),
      counts: Object.freeze(Object.fromEntries(Object.entries(snapshot).map(([name, rows]) => [name, rows.length]))),
      snapshot: Object.freeze(snapshot),
    }));
  } catch (cause) {
    outcome = err('CatalogCaptureFailed', 'Could not capture the local PostgreSQL catalog', {}, cause);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      if (outcome?._tag !== 'err') outcome = err('CatalogCleanupFailed', 'Could not close the local catalog database client', {}, cause);
    }
  }
  return outcome;
}

/**
 * Compare a captured catalog with the committed reference.
 *
 * @param {Record<string, unknown>} capture - Captured catalog and fingerprint.
 * @param {Record<string, unknown>} reference - Committed catalog reference.
 * @returns {{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Validated capture or tagged drift.
 */
export function validateCatalogReference(capture, reference) {
  if (reference.version !== 1) {
    return err('CatalogReferenceInvalid', `unsupported catalog reference version: ${reference.version}`);
  }
  if (capture.fingerprint !== reference.fingerprint) {
    return err(
      'CatalogDriftDetected',
      `catalog fingerprint mismatch: expected ${reference.fingerprint}, received ${capture.fingerprint}`,
      { expectedFingerprint: reference.fingerprint, actualFingerprint: capture.fingerprint },
    );
  }
  return ok(capture);
}

/**
 * Capture the local catalog and compare it with the committed reference.
 *
 * @param {object} [options] - Reference, filesystem and capture overrides.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: string } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Matching fingerprint or tagged failure.
 */
export async function captureAndValidateDatabaseCatalog({
  referencePath = CATALOG_REFERENCE_PATH,
  fileSystem = fs,
  capture = captureDatabaseCatalog,
} = {}) {
  const captureResult = await capture();
  if (captureResult._tag === 'err') return captureResult;
  let reference;
  try {
    reference = JSON.parse(fileSystem.readFileSync(referencePath, 'utf8'));
  } catch (cause) {
    return err('CatalogReferenceReadFailed', `Could not read catalog reference: ${referencePath}`, { referencePath }, cause);
  }
  const validation = validateCatalogReference(captureResult.value, reference);
  if (validation._tag === 'err') return validation;
  console.log(`[database-lab] catalog ${captureResult.value.fingerprint} ${JSON.stringify(captureResult.value.counts)}`);
  return ok(captureResult.value.fingerprint);
}

/**
 * Deliberately replace the committed catalog fingerprint from a rebuilt local database.
 *
 * @param {object} [options] - Reference, filesystem and capture overrides.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Written reference or tagged failure.
 */
export async function writeCatalogReference({
  referencePath = CATALOG_REFERENCE_PATH,
  fileSystem = fs,
  capture = captureDatabaseCatalog,
} = {}) {
  const captureResult = await capture();
  if (captureResult._tag === 'err') return captureResult;
  const reference = Object.freeze({
    version: 1,
    fingerprint: captureResult.value.fingerprint,
    counts: captureResult.value.counts,
  });
  try {
    fileSystem.writeFileSync(referencePath, `${JSON.stringify(reference, null, 2)}\n`, 'utf8');
    return ok(reference);
  } catch (cause) {
    return err('CatalogReferenceWriteFailed', `Could not write catalog reference: ${referencePath}`, { referencePath }, cause);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/database-catalog.mjs')) {
  if (!process.argv.includes('--write-reference')) {
    console.error('Use --write-reference with a rebuilt local database to update the catalog contract.');
    process.exitCode = 1;
  } else {
    const result = await writeCatalogReference();
    if (result._tag === 'err') {
      console.error(failureMessage(result.error));
      process.exitCode = 1;
    } else {
      console.log(`Wrote catalog reference ${result.value.fingerprint}.`);
    }
  }
}
