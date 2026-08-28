import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { err, ok } from './script-result.mjs';

/** Port of the disposable Supabase local lab used as the backup source (see `database-lab.mjs`). */
export const SOURCE_PORT = 54322;
/** Dedicated container for the restore target — never the shared dev/source lab. */
export const RESTORE_CONTAINER_NAME = 'orbita-backup-restore-lab';
/** Host port for the restore target, distinct from the source lab port. */
export const RESTORE_PORT = 55432;
/** Pinned image matching the local lab's Postgres major version (17), so `pg_dump`/`pg_restore`
 * client tools and server-side roles/extensions match exactly. Never a remote/shared image tag. */
export const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.158';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'host.docker.internal']);
const ALLOWED_PORTS = new Set([SOURCE_PORT, RESTORE_PORT]);

/**
 * Defense-in-depth guard: refuse to build any command targeting a host/port outside the
 * two disposable local instances this lab is allowed to touch. Mirrors `parseLocalOnlyPlan`
 * in `database-lab.mjs`.
 *
 * @param {string} host
 * @param {number} port
 * @returns {{ readonly _tag: 'ok', readonly value: true } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }}
 */
export function assertLocalOnlyTarget(host, port) {
  if (!ALLOWED_HOSTS.has(host)) {
    return err('UnsafeBackupRestoreTarget', `Backup/restore lab refuses non-local host: ${host}`, { host });
  }
  if (!ALLOWED_PORTS.has(port)) {
    return err('UnsafeBackupRestoreTarget', `Backup/restore lab refuses port outside the disposable lab pair: ${port}`, { port });
  }
  return ok(true);
}

function dockerRunPrefix(hostDumpDir, image) {
  return [
    'run', '--rm',
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${hostDumpDir}:/dump`,
    '-e', 'PGPASSWORD=postgres',
    image,
  ];
}

/**
 * Build the `docker run` argv that dumps the app-owned `public` schema (full schema + data,
 * custom format) — everything created by ORBITA's own migrations. The Supabase base image
 * pre-provisions `auth`/`storage`/etc. identically in both instances, so those schemas are
 * never dumped/restored at the schema level (only `auth.users` data — see
 * `buildPgDumpAuthUsersArgs`), which avoids "already exists" conflicts against the target's
 * own bootstrap.
 *
 * @param {{ hostDumpDir: string, dumpFileName: string, image?: string, sourcePort?: number }} options
 * @returns {ReadonlyArray<string>} argv (no shell interpolation).
 */
export function buildPgDumpPublicArgs({ hostDumpDir, dumpFileName, image = PG_IMAGE, sourcePort = SOURCE_PORT }) {
  return Object.freeze([
    ...dockerRunPrefix(hostDumpDir, image),
    'pg_dump',
    '-h', 'host.docker.internal',
    '-p', String(sourcePort),
    '-U', 'postgres',
    '-d', 'postgres',
    '-n', 'public',
    '-F', 'c',
    '--no-owner',
    '--no-privileges',
    '-f', `/dump/${dumpFileName}`,
  ]);
}

/**
 * Build the `docker run` argv that dumps only the DATA rows of `auth.users` (never its
 * schema, which the target's own bootstrap already provisions identically).
 *
 * @param {{ hostDumpDir: string, dumpFileName: string, image?: string, sourcePort?: number }} options
 * @returns {ReadonlyArray<string>} argv (no shell interpolation).
 */
export function buildPgDumpAuthUsersArgs({ hostDumpDir, dumpFileName, image = PG_IMAGE, sourcePort = SOURCE_PORT }) {
  return Object.freeze([
    ...dockerRunPrefix(hostDumpDir, image),
    'pg_dump',
    '-h', 'host.docker.internal',
    '-p', String(sourcePort),
    '-U', 'postgres',
    '-d', 'postgres',
    '-t', 'auth.users',
    '--data-only',
    '-F', 'c',
    '--no-owner',
    '--no-privileges',
    '-f', `/dump/${dumpFileName}`,
  ]);
}

/**
 * Build the `docker run` argv that restores the `public` schema dump into the (already
 * running, genuinely empty-of-app-objects) restore target instance. No `--clean`: the
 * target's `public` schema never had ORBITA's tables before this restore, so `DROP ... IF
 * EXISTS` statements against not-yet-existing relations would themselves fail (Postgres
 * still errors on `DROP POLICY/TRIGGER ... ON <missing table>` even with `IF EXISTS`).
 *
 * @param {{ hostDumpDir: string, dumpFileName: string, image?: string, targetPort?: number }} options
 * @returns {ReadonlyArray<string>} argv (no shell interpolation).
 */
export function buildPgRestorePublicArgs({ hostDumpDir, dumpFileName, image = PG_IMAGE, targetPort = RESTORE_PORT }) {
  return Object.freeze([
    ...dockerRunPrefix(hostDumpDir, image),
    'pg_restore',
    '-h', 'host.docker.internal',
    '-p', String(targetPort),
    '-U', 'postgres',
    '-d', 'postgres',
    '--no-owner',
    '--no-privileges',
    `/dump/${dumpFileName}`,
  ]);
}

/**
 * Build the `docker run` argv that restores `auth.users` DATA rows into the target's own
 * (already schema-provisioned, empty) `auth.users` table.
 *
 * @param {{ hostDumpDir: string, dumpFileName: string, image?: string, targetPort?: number }} options
 * @returns {ReadonlyArray<string>} argv (no shell interpolation).
 */
export function buildPgRestoreAuthUsersArgs({ hostDumpDir, dumpFileName, image = PG_IMAGE, targetPort = RESTORE_PORT }) {
  return Object.freeze([
    ...dockerRunPrefix(hostDumpDir, image),
    'pg_restore',
    '-h', 'host.docker.internal',
    '-p', String(targetPort),
    '-U', 'postgres',
    '-d', 'postgres',
    '--no-owner',
    '--no-privileges',
    '--data-only',
    `/dump/${dumpFileName}`,
  ]);
}

/**
 * Build the `docker run` argv that starts the dedicated, empty restore target container.
 *
 * @param {{ name?: string, port?: number, image?: string }} [options]
 * @returns {ReadonlyArray<string>} argv (no shell interpolation).
 */
export function buildStartRestoreTargetArgs({ name = RESTORE_CONTAINER_NAME, port = RESTORE_PORT, image = PG_IMAGE } = {}) {
  return Object.freeze([
    'run', '-d',
    '--name', name,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=postgres',
    '-p', `${port}:5432`,
    image,
  ]);
}

/** Build the argv that permanently removes the dedicated restore target container. */
export function buildRemoveRestoreTargetArgs({ name = RESTORE_CONTAINER_NAME } = {}) {
  return Object.freeze(['rm', '-f', name]);
}

/**
 * Build the argv that proves the restore target can actually execute a query, not merely
 * accept a TCP connection. The Supabase Postgres image runs a second, longer init pass
 * (auth/storage/extensions) after its first `pg_isready`-visible startup, briefly closing
 * connections mid-init — `pg_isready` alone reports ready too early, so this runs a real
 * `SELECT 1` inside the container instead.
 */
export function buildPgIsReadyArgs({ name = RESTORE_CONTAINER_NAME } = {}) {
  return Object.freeze(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', 'select 1']);
}

/**
 * Run one Docker step without a shell, returning byte size when the step wrote a file.
 *
 * @param {ReadonlyArray<string>} args
 * @returns {{ readonly _tag: 'ok', readonly value: { stdout: string } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }}
 */
export function runDocker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (process.env.BACKUP_LAB_DEBUG) {
    console.error(`DEBUG docker ${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nstatus: ${result.status}`);
  }
  if (result.error) {
    return err('DockerStepStartFailed', `Docker step could not start: docker ${args[0]}`, {}, result.error);
  }
  if (result.status !== 0) {
    return err(
      'DockerStepFailed',
      `Docker step failed (exit ${result.status}): docker ${args.join(' ')}`,
      { exitCode: result.status, stderr: result.stderr?.slice(0, 2000) },
    );
  }
  return ok({ stdout: result.stdout ?? '' });
}

/**
 * Poll `pg_isready` on the restore target until it accepts connections or the deadline passes.
 *
 * @param {{ maxAttempts?: number, delayMs?: number, run?: (args: ReadonlyArray<string>) => ReturnType<typeof runDocker>, sleep?: (ms: number) => Promise<void> }} [options]
 */
export async function waitForRestoreTargetReady({
  maxAttempts = 40,
  delayMs = 1000,
  consecutiveSuccessesRequired = 3,
  run = runDocker,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let consecutiveSuccesses = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = run(buildPgIsReadyArgs());
    consecutiveSuccesses = result._tag === 'ok' ? consecutiveSuccesses + 1 : 0;
    if (consecutiveSuccesses >= consecutiveSuccessesRequired) return ok({ attempts: attempt });
    await sleep(delayMs);
  }
  return err('RestoreTargetNeverReady', `Restore target did not become stably ready after ${maxAttempts} attempts`, { maxAttempts });
}

/** Byte size of a file on disk, or 0 if it does not exist. */
export function fileByteSize(filePath, fileSystem = fs) {
  if (!fileSystem.existsSync(filePath)) return 0;
  return fileSystem.statSync(filePath).size;
}

/**
 * Capture a validation fingerprint of a Postgres instance's public schema: per-table row
 * counts and a stable checksum, plus constraint/RLS/function/index counts.
 *
 * @param {{ query: (sql: string) => Promise<{ rows: any[] }> }} client - Connected pg client.
 */
/** Strict identifier shape: Postgres has no parameterized-identifier syntax, so every
 * table name interpolated into SQL below must pass this allowlist first. Defense in depth:
 * `tableName` always originates from `information_schema.tables` (this lab's own trusted
 * catalog query), never from user/network input. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertSafeIdentifier(identifier) {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Refusing to interpolate an unsafe SQL identifier: ${JSON.stringify(identifier)}`);
  }
  return identifier;
}

export async function captureSchemaFingerprint(client) {
  const tablesResult = await client.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  const tables = [];
  for (const { table_name: rawTableName } of tablesResult.rows) {
    const tableName = assertSafeIdentifier(rawTableName);
    const countResult = await client.query(`select count(*)::bigint as count from "${tableName}"`);
    const checksumResult = await client.query(
      `select coalesce(md5(string_agg(row_hash, ',' order by row_hash)), 'empty') as checksum
       from (select md5(t::text) as row_hash from "${tableName}" t) as rows`,
    );
    tables.push({
      table: tableName,
      count: Number(countResult.rows[0].count),
      checksum: checksumResult.rows[0].checksum,
    });
  }

  const constraintsResult = await client.query(
    `select constraint_type, count(*)::int as count from information_schema.table_constraints
     where table_schema = 'public' group by constraint_type order by constraint_type`,
  );
  const policiesResult = await client.query(`select count(*)::int as count from pg_policies where schemaname = 'public'`);
  const rlsResult = await client.query(`select count(*)::int as count from pg_tables where schemaname = 'public' and rowsecurity = true`);
  const functionsResult = await client.query(`select count(*)::int as count from information_schema.routines where routine_schema = 'public'`);
  const indexesResult = await client.query(`select count(*)::int as count from pg_indexes where schemaname = 'public'`);

  return {
    tables,
    constraintsByType: constraintsResult.rows,
    policyCount: policiesResult.rows[0].count,
    rlsEnabledTableCount: rlsResult.rows[0].count,
    functionCount: functionsResult.rows[0].count,
    indexCount: indexesResult.rows[0].count,
  };
}

/**
 * Diff two schema fingerprints. Returns an array of human-readable mismatch descriptions;
 * empty means the restore reproduced the source exactly for everything this lab checks.
 */
export function diffFingerprints(source, target) {
  const errors = [];
  const sourceByTable = new Map(source.tables.map((t) => [t.table, t]));
  const targetByTable = new Map(target.tables.map((t) => [t.table, t]));

  if (sourceByTable.size !== targetByTable.size) {
    errors.push(`table count differs: source=${sourceByTable.size} target=${targetByTable.size}`);
  }
  for (const [name, sourceTable] of sourceByTable) {
    const targetTable = targetByTable.get(name);
    if (!targetTable) {
      errors.push(`table missing after restore: ${name}`);
      continue;
    }
    if (sourceTable.count !== targetTable.count) {
      errors.push(`row count differs for ${name}: source=${sourceTable.count} target=${targetTable.count}`);
    }
    if (sourceTable.checksum !== targetTable.checksum) {
      errors.push(`checksum differs for ${name}`);
    }
  }

  if (JSON.stringify(source.constraintsByType) !== JSON.stringify(target.constraintsByType)) {
    errors.push('constraint counts by type differ between source and restored target');
  }
  if (source.policyCount !== target.policyCount) {
    errors.push(`RLS policy count differs: source=${source.policyCount} target=${target.policyCount}`);
  }
  if (source.rlsEnabledTableCount !== target.rlsEnabledTableCount) {
    errors.push(`RLS-enabled table count differs: source=${source.rlsEnabledTableCount} target=${target.rlsEnabledTableCount}`);
  }
  if (source.functionCount !== target.functionCount) {
    errors.push(`function count differs: source=${source.functionCount} target=${target.functionCount}`);
  }
  if (source.indexCount !== target.indexCount) {
    errors.push(`index count differs: source=${source.indexCount} target=${target.indexCount}`);
  }
  return errors;
}

export function ensureDumpDirectory(hostDumpDir, fileSystem = fs) {
  if (!fileSystem.existsSync(hostDumpDir)) fileSystem.mkdirSync(hostDumpDir, { recursive: true });
}

/** Remove the dump file after evidence (size/checksum) has been recorded — never keep raw dumps around. */
export function deleteDumpFile(filePath, fileSystem = fs) {
  if (fileSystem.existsSync(filePath)) fileSystem.unlinkSync(filePath);
}

export function resolveDumpPath(hostDumpDir, dumpFileName) {
  return path.join(hostDumpDir, dumpFileName);
}
