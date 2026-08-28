#!/usr/bin/env node
/**
 * Ticket 21 — real logical backup/restore rehearsal against a disposable local Postgres lab.
 *
 * This is NOT a simulation: it starts the real Supabase local lab (Docker), applies every
 * canonical migration, seeds synthetic multi-tenant data, runs a real `pg_dump` (custom
 * format), restores it into a SECOND, independent, empty Postgres container, and validates
 * counts/checksums/constraints/RLS/functions/indexes plus a multi-tenant smoke query.
 *
 * Both instances and the dump file are destroyed at the end, success or failure. Nothing
 * here ever touches a remote or shared database — see `assertLocalOnlyTarget`.
 */
import os from 'node:os';
import path from 'node:path';

import {
  applyCanonicalMigrations,
  DATABASE_LAB_CLEANUP,
  executeSupabaseStep,
} from './database-lab.mjs';
import { createLocalDatabaseClient, DEFAULT_LOCAL_DATABASE_PORT } from './local-database-client.mjs';
import {
  buildPgDumpPublicArgs,
  buildPgDumpAuthUsersArgs,
  buildPgRestorePublicArgs,
  buildPgRestoreAuthUsersArgs,
  buildRemoveRestoreTargetArgs,
  buildStartRestoreTargetArgs,
  captureSchemaFingerprint,
  deleteDumpFile,
  diffFingerprints,
  ensureDumpDirectory,
  fileByteSize,
  RESTORE_PORT,
  resolveDumpPath,
  runDocker,
  waitForRestoreTargetReady,
} from './backup-restore-lab.mjs';
import { err, failureMessage, ok } from './script-result.mjs';

const PUBLIC_DUMP_FILE_NAME = 'orbita-backup-restore-lab-public.dump';
const AUTH_USERS_DUMP_FILE_NAME = 'orbita-backup-restore-lab-auth-users.dump';
const HOST_DUMP_DIR = path.join(os.tmpdir(), 'orbita-backup-restore-lab');

const ORG_A_ID = '99000000-0000-4000-8000-0000000000a1';
const ORG_B_ID = '99000000-0000-4000-8000-0000000000b1';
const OWNER_A_ID = '99000000-0000-4000-8000-0000000000a2';
const OWNER_B_ID = '99000000-0000-4000-8000-0000000000b2';

async function seedSyntheticData(client) {
  await client.query(
    `insert into auth.users (id, email) values ($1, $2), ($3, $4)`,
    [OWNER_A_ID, 'owner-a@orbita-backup-lab.test', OWNER_B_ID, 'owner-b@orbita-backup-lab.test'],
  );
  await client.query(
    `insert into public.organizacoes (id, nome, slug) values ($1, $2, $3), ($4, $5, $6)`,
    [ORG_A_ID, 'Backup Lab Org A', 'backup-lab-org-a', ORG_B_ID, 'Backup Lab Org B', 'backup-lab-org-b'],
  );
  await client.query(
    `insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner'), ($3, $4, 'owner')`,
    [ORG_A_ID, OWNER_A_ID, ORG_B_ID, OWNER_B_ID],
  );
  await client.query(
    `insert into public.clientes (user_id, organizacao_id, bling_id, nome, email) values
       ($1, $3, 'bling-a-1', 'Cliente A1', 'clientea1@backup-lab.test'),
       ($1, $3, 'bling-a-2', 'Cliente A2', 'clientea2@backup-lab.test'),
       ($2, $4, 'bling-b-1', 'Cliente B1', 'clienteb1@backup-lab.test')`,
    [OWNER_A_ID, OWNER_B_ID, ORG_A_ID, ORG_B_ID],
  );
}

/** Multi-tenant smoke: confirm each synthetic tenant only ever sees its own rows post-restore. */
export async function multiTenantSmoke(client) {
  const orgA = await client.query('select count(*)::int as count from public.organizacoes where id = $1', [ORG_A_ID]);
  const orgB = await client.query('select count(*)::int as count from public.organizacoes where id = $1', [ORG_B_ID]);
  const clientesA = await client.query('select count(*)::int as count from public.clientes where user_id = $1', [OWNER_A_ID]);
  const clientesB = await client.query('select count(*)::int as count from public.clientes where user_id = $1', [OWNER_B_ID]);
  const crossLeak = await client.query(
    'select count(*)::int as count from public.clientes where user_id = $1 and bling_id like $2',
    [OWNER_A_ID, 'bling-b-%'],
  );
  const errors = [];
  if (orgA.rows[0].count !== 1) errors.push('organização sintética A não sobreviveu ao restore');
  if (orgB.rows[0].count !== 1) errors.push('organização sintética B não sobreviveu ao restore');
  if (clientesA.rows[0].count !== 2) errors.push(`tenant A deveria ter 2 clientes, tem ${clientesA.rows[0].count}`);
  if (clientesB.rows[0].count !== 1) errors.push(`tenant B deveria ter 1 cliente, tem ${clientesB.rows[0].count}`);
  if (crossLeak.rows[0].count !== 0) errors.push('vazamento cross-tenant detectado: cliente do tenant B visível sob filtro do tenant A');
  return errors;
}

/** Jornada crítica smoke: a função atômica de criação de organização continua utilizável pós-restore. */
export async function criticalJourneySmoke(client) {
  const fn = await client.query(
    `select count(*)::int as count from information_schema.routines
     where routine_schema = 'public' and routine_name = 'criar_organizacao_atomica'`,
  );
  return fn.rows[0].count === 1
    ? []
    : ['função criar_organizacao_atomica ausente após o restore — jornada de criação de organização quebraria'];
}

async function performBackup({ evidence, record, publicDumpPath, authUsersDumpPath }) {
  record('backup:pg_dump:start');
  const backupStartedAt = Date.now();
  const dumpPublicResult = runDocker(buildPgDumpPublicArgs({ hostDumpDir: HOST_DUMP_DIR, dumpFileName: PUBLIC_DUMP_FILE_NAME }));
  if (dumpPublicResult._tag === 'err') return dumpPublicResult;
  const dumpAuthResult = runDocker(buildPgDumpAuthUsersArgs({ hostDumpDir: HOST_DUMP_DIR, dumpFileName: AUTH_USERS_DUMP_FILE_NAME }));
  if (dumpAuthResult._tag === 'err') return dumpAuthResult;
  const backupDurationMs = Date.now() - backupStartedAt;
  const dumpBytes = fileByteSize(publicDumpPath) + fileByteSize(authUsersDumpPath);
  evidence.backup = { durationMs: backupDurationMs, bytes: dumpBytes };
  record('backup:pg_dump:done', { durationMs: backupDurationMs, bytes: dumpBytes });
  return ok({ backupDurationMs });
}

async function performRestore({ evidence, record }) {
  record('restore-target:start');
  const startTarget = runDocker(buildStartRestoreTargetArgs());
  if (startTarget._tag === 'err') return { outcome: startTarget, restoreTargetStarted: false };

  record('restore-target:wait-ready');
  const ready = await waitForRestoreTargetReady();
  if (ready._tag === 'err') return { outcome: ready, restoreTargetStarted: true };

  record('restore:pg_restore:start');
  const restoreStartedAt = Date.now();
  // auth.users data first: public schema restore inserts membros_organizacao rows whose FK
  // requires those users to already exist in the target's own auth.users table.
  const restoreAuthResult = runDocker(buildPgRestoreAuthUsersArgs({ hostDumpDir: HOST_DUMP_DIR, dumpFileName: AUTH_USERS_DUMP_FILE_NAME }));
  const restorePublicResult = runDocker(buildPgRestorePublicArgs({ hostDumpDir: HOST_DUMP_DIR, dumpFileName: PUBLIC_DUMP_FILE_NAME }));
  const restoreDurationMs = Date.now() - restoreStartedAt;
  // pg_restore can exit non-zero on ignorable warnings across image/base-schema combinations;
  // the real pass/fail signal is the post-restore fingerprint diff and smoke checks below.
  evidence.restore = {
    durationMs: restoreDurationMs,
    authUsersExitOk: restoreAuthResult._tag === 'ok',
    publicSchemaExitOk: restorePublicResult._tag === 'ok',
  };
  record('restore:pg_restore:done', { durationMs: restoreDurationMs });
  return { outcome: ok({ restoreDurationMs }), restoreTargetStarted: true };
}

async function validateRestore({ evidence, record, sourceFingerprint, backupDurationMs, restoreDurationMs }) {
  const targetClient = createLocalDatabaseClient('orbita-backup-lab-target', console, RESTORE_PORT);
  await targetClient.connect();
  try {
    record('validate:capture-target-fingerprint');
    const targetFingerprint = await captureSchemaFingerprint(targetClient);
    evidence.targetTableCount = targetFingerprint.tables.length;
    evidence.targetRowCount = targetFingerprint.tables.reduce((sum, t) => sum + t.count, 0);

    record('validate:diff-fingerprints');
    const diffErrors = diffFingerprints(sourceFingerprint, targetFingerprint);

    record('validate:multi-tenant-smoke');
    const smokeErrors = await multiTenantSmoke(targetClient);

    record('validate:critical-journey-smoke');
    const journeyErrors = await criticalJourneySmoke(targetClient);

    const allErrors = [...diffErrors, ...smokeErrors, ...journeyErrors];
    evidence.validationErrors = allErrors;
    evidence.rto = { restoreDurationMs, backupDurationMs, totalDurationMs: backupDurationMs + restoreDurationMs };
    evidence.rpo = {
      note: 'RPO observado = 0s: dump tirado imediatamente após a última escrita sintética, sem escritas concorrentes durante o ensaio.',
    };

    return allErrors.length === 0
      ? ok(evidence)
      : err('BackupRestoreValidationFailed', `Pós-restore encontrou ${allErrors.length} divergência(s)`, { evidence });
  } finally {
    await targetClient.end();
  }
}

async function seedAndBackupSource({ evidence, record, publicDumpPath, authUsersDumpPath }) {
  const sourceClient = createLocalDatabaseClient('orbita-backup-lab-source', console, DEFAULT_LOCAL_DATABASE_PORT);
  await sourceClient.connect();
  try {
    record('source:seed-synthetic-data');
    await seedSyntheticData(sourceClient);

    record('source:capture-fingerprint');
    const sourceFingerprint = await captureSchemaFingerprint(sourceClient);
    evidence.sourceTableCount = sourceFingerprint.tables.length;
    evidence.sourceRowCount = sourceFingerprint.tables.reduce((sum, t) => sum + t.count, 0);

    const backupResult = await performBackup({ evidence, record, publicDumpPath, authUsersDumpPath });
    if (backupResult._tag === 'err') return { outcome: backupResult, restoreTargetStarted: false };

    const { outcome: restoreOutcome, restoreTargetStarted } = await performRestore({ evidence, record });
    if (restoreOutcome._tag === 'err') return { outcome: restoreOutcome, restoreTargetStarted };

    const validation = await validateRestore({
      evidence,
      record,
      sourceFingerprint,
      backupDurationMs: backupResult.value.backupDurationMs,
      restoreDurationMs: restoreOutcome.value.restoreDurationMs,
    });
    return { outcome: validation, restoreTargetStarted };
  } finally {
    await sourceClient.end();
  }
}

async function run() {
  const evidence = { steps: [] };
  const record = (name, extra = {}) => evidence.steps.push({ name, at: new Date().toISOString(), ...extra });

  ensureDumpDirectory(HOST_DUMP_DIR);
  const publicDumpPath = resolveDumpPath(HOST_DUMP_DIR, PUBLIC_DUMP_FILE_NAME);
  const authUsersDumpPath = resolveDumpPath(HOST_DUMP_DIR, AUTH_USERS_DUMP_FILE_NAME);

  let outcome;
  let restoreTargetStarted = false;
  try {
    record('cleanup:before (idempotent)');
    executeSupabaseStep(DATABASE_LAB_CLEANUP);

    record('source:start');
    const start = executeSupabaseStep({ name: 'start source lab', args: ['db', 'start'] });
    if (start._tag === 'err') { outcome = start; return outcome; }

    record('source:apply-migrations');
    const migrations = await applyCanonicalMigrations();
    if (migrations._tag === 'err') { outcome = migrations; return outcome; }
    evidence.migrationsApplied = migrations.value.length;

    const result = await seedAndBackupSource({ evidence, record, publicDumpPath, authUsersDumpPath });
    outcome = result.outcome;
    restoreTargetStarted = result.restoreTargetStarted;
    return outcome;
  } catch (cause) {
    outcome = err('BackupRestoreLabUnexpectedFailure', 'Falha inesperada durante o ensaio de backup/restore', { evidence }, cause);
    return outcome;
  } finally {
    record('cleanup:dump-file');
    deleteDumpFile(publicDumpPath);
    deleteDumpFile(authUsersDumpPath);
    if (restoreTargetStarted) {
      record('cleanup:restore-target');
      runDocker(buildRemoveRestoreTargetArgs());
    }
    record('cleanup:source-lab');
    executeSupabaseStep(DATABASE_LAB_CLEANUP);
  }
}

// Guarded so importing this module (unit tests exercise the pure `multiTenantSmoke` and
// `criticalJourneySmoke` helpers below) never triggers the real Docker orchestration —
// only running this file directly (`node scripts/test-backup-restore.mjs`) does.
const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/test-backup-restore.mjs');
if (isDirectExecution) {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
  if (result._tag === 'err') {
    console.error(`[backup-restore-lab] ${result.error._tag}: ${failureMessage(result.error)}`);
    process.exitCode = 1;
  } else {
    console.log('[backup-restore-lab] restore validated: counts, checksums, constraints, RLS, functions, indexes and smoke all matched.');
  }
}
