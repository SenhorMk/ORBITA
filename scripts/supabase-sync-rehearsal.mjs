/**
 * Generates and rehearses the Supabase sync package entirely against the disposable local lab.
 *
 * There is no real Supabase remote project confirmed yet (see
 * `.scratch/orbita-mvp-producao-v2/evidence/22-checkpoint.md`). This script never connects
 * anywhere except `127.0.0.1:54322` (the same lab `test:db` already uses) — that connection is
 * enforced by `assertSimulatedRemoteTarget`. It builds a synthetic "outdated remote" by applying
 * every ledger migration except the last one, captures a read-only snapshot of it, classifies
 * drift against the full ledger, generates the phased bundle, then rehearses applying the
 * bundle twice and confirms the resulting catalog fingerprint matches the committed
 * `database/catalog-reference.json` — i.e. the bundle reproduces exactly the same approved
 * end-state as a normal full lab run, twice, deterministically.
 */
import fs from 'node:fs';
import path from 'node:path';

import { CATALOG_REFERENCE_PATH, captureDatabaseCatalog } from './database-catalog.mjs';
import {
  DATABASE_LAB_CLEANUP,
  applyCanonicalMigrations,
  databaseLabCycleSteps,
  executeSupabaseStep,
} from './database-lab.mjs';
import { readCanonicalLedger, SUPABASE_CONFIG_PATH } from './database-ledger.mjs';
import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, failureMessage, ok } from './script-result.mjs';
import {
  assertSimulatedRemoteTarget,
  buildApprovalForm,
  buildRollbackPlan,
  buildSyncBundle,
  classifyDrift,
  estimateBackfillFromReltuples,
  readAppVersion,
} from './supabase-sync-package.mjs';

const HELD_BACK_COUNT = 1; // simulate a remote missing the last N approved migrations

function readMigrationSql(migration, fileSystem) {
  if (migration.path === './lab/00_bootstrap_schema.sql') return '';
  const absolutePath = path.resolve(path.dirname(SUPABASE_CONFIG_PATH), migration.path);
  return fileSystem.readFileSync(absolutePath, 'utf8').replace(/^﻿/, '');
}

async function captureReltuples(client, tableNames) {
  if (tableNames.length === 0) return [];
  const result = await client.query(
    `select c.relname, c.reltuples from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1::text[])`,
    [tableNames],
  );
  return result.rows;
}

async function applyBaselineAndBundle({ cycle, ledger, missingMigrations, fileSystem }) {
  const client = createLocalDatabaseClient(`orbita-supabase-sync-rehearsal-${cycle}`);
  let outcome;
  try {
    const baselineLedger = ok({ ...ledger, migrations: ledger.migrations.slice(0, ledger.migrations.length - HELD_BACK_COUNT) });
    const baseline = await applyCanonicalMigrations({ client: createLocalDatabaseClient(`orbita-sync-rehearsal-baseline-${cycle}`), ledgerResult: baselineLedger, fileSystem });
    if (baseline._tag === 'err') return baseline;

    // Read-only inspection of the synthetic outdated remote BEFORE applying the bundle — the
    // real object it produces (via `captureDatabaseCatalog`), not a regex approximation. This is
    // what `classifyDrift` below is run against, so the drift report reflects an actual captured
    // snapshot, not a guess.
    const remoteSnapshotResult = await captureDatabaseCatalog();
    if (remoteSnapshotResult._tag === 'err') return remoteSnapshotResult;

    await client.connect();
    for (const migration of missingMigrations) {
      const sql = readMigrationSql(migration, fileSystem);
      await client.query(sql);
    }
    const reltuplesRows = await captureReltuples(client, ['catalogo_eventos_auditoria']);
    outcome = ok(Object.freeze({ reltuplesRows, remoteSnapshot: remoteSnapshotResult.value.snapshot }));
  } catch (cause) {
    outcome = err('SyncRehearsalApplyFailed', `Could not apply the sync bundle during rehearsal cycle ${cycle}`, { cycle }, cause);
  } finally {
    try {
      await client.end();
    } catch {
      // connection may already be closed by an earlier failure; caller still tears down the lab
    }
  }
  return outcome;
}

/**
 * Run one full rehearsal cycle: start a fresh disposable lab, apply the baseline (ledger minus
 * the held-back migrations) plus the bundle (the held-back migrations), run the FINAL catalog
 * pgTAP suite (`supabase/tests/final`, the same suite `database-lab.mjs` runs after migrations
 * — never the per-migration historical suite, which expects an empty database and would collide
 * with the baseline+bundle already applied here), capture the resulting catalog fingerprint, and
 * always tear the lab down, mirroring `runCycle` in `database-lab.mjs`.
 */
async function runRehearsalCycle({ cycle, ledger, missingMigrations, fileSystem }) {
  const [start] = databaseLabCycleSteps(`sync-rehearsal ${cycle}`);
  const [, finalTestStep] = databaseLabCycleSteps(cycle);
  let outcome;
  let applyOutcome;
  try {
    outcome = executeSupabaseStep(start);
    if (outcome._tag === 'ok') {
      applyOutcome = await applyBaselineAndBundle({ cycle, ledger, missingMigrations, fileSystem });
      outcome = applyOutcome;
    }
    if (outcome._tag === 'ok') outcome = executeSupabaseStep(finalTestStep);
    if (outcome._tag === 'ok') {
      const catalogResult = await captureDatabaseCatalog();
      outcome = catalogResult._tag === 'err' ? catalogResult : ok(Object.freeze({
        cycle,
        reltuplesRows: applyOutcome.value.reltuplesRows,
        remoteSnapshot: applyOutcome.value.remoteSnapshot,
        finalPgTapStep: finalTestStep.name,
        catalogFingerprint: catalogResult.value.fingerprint,
      }));
    }
  } catch (cause) {
    outcome = err('UnexpectedSyncRehearsalCycleFailure', `Unexpected failure during sync rehearsal cycle ${cycle}`, { cycle }, cause);
  } finally {
    let teardown;
    try {
      teardown = executeSupabaseStep(DATABASE_LAB_CLEANUP);
    } catch (cause) {
      teardown = err('DatabaseLabCleanupFailed', `Sync rehearsal lab cleanup threw after cycle ${cycle}`, { cycle }, cause);
    }
    if (teardown._tag === 'err') outcome = teardown;
  }
  return outcome;
}

/**
 * Run the full generate-and-rehearse flow. Always tears down the lab, even on failure.
 *
 * @param {{ fileSystem?: typeof fs, cycles?: number, artifactsRoot?: string }} [options]
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>}
 */
export async function generateAndRehearseSyncPackage({
  fileSystem = fs,
  cycles = 2,
  artifactsRoot = path.resolve(process.cwd(), 'artifacts', 'supabase-sync'),
} = {}) {
  const targetGuard = assertSimulatedRemoteTarget('127.0.0.1', 54322);
  if (targetGuard._tag === 'err') return targetGuard;

  const ledgerResult = readCanonicalLedger();
  if (ledgerResult._tag === 'err') return ledgerResult;
  const ledger = ledgerResult.value;
  const migrationSqlByOrder = ledger.migrations.map((migration) => readMigrationSql(migration, fileSystem));

  const heldBackMigrations = ledger.migrations.slice(ledger.migrations.length - HELD_BACK_COUNT);

  // Best-effort initial cleanup in case a previous failed run left the lab up (mirrors
  // `runDatabaseLab`'s own initial cleanup in `database-lab.mjs`). Each cycle below tears down
  // the lab itself when it finishes, so no cleanup is needed after the loop.
  let initialCleanup;
  try {
    initialCleanup = executeSupabaseStep(DATABASE_LAB_CLEANUP);
  } catch (cause) {
    initialCleanup = err('DatabaseLabCleanupFailed', 'Initial sync rehearsal lab cleanup threw', {}, cause);
  }
  if (initialCleanup._tag === 'err') return initialCleanup;

  let outcome;
  const cycleResults = [];
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    let cycleResult;
    try {
      cycleResult = await runRehearsalCycle({ cycle, ledger, missingMigrations: heldBackMigrations, fileSystem });
    } catch (cause) {
      cycleResult = err('UnexpectedSyncRehearsalFailure', `Unexpected failure during sync rehearsal cycle ${cycle}`, { cycle }, cause);
    }
    if (cycleResult._tag === 'err') {
      outcome = cycleResult;
      break;
    }
    cycleResults.push(cycleResult.value);
  }
  if (outcome?._tag === 'err') return outcome;

  const fingerprints = cycleResults.map((c) => c.catalogFingerprint);
  if (new Set(fingerprints).size !== 1) {
    return err('SyncRehearsalDrift', `Catalog drift between rehearsal cycles: ${fingerprints.join(' != ')}`, { fingerprints });
  }
  let reference;
  try {
    reference = JSON.parse(fileSystem.readFileSync(CATALOG_REFERENCE_PATH, 'utf8'));
  } catch (cause) {
    return err('CatalogReferenceReadFailed', `Could not read catalog reference: ${CATALOG_REFERENCE_PATH}`, {}, cause);
  }
  if (fingerprints[0] !== reference.fingerprint) {
    return err(
      'SyncRehearsalDoesNotMatchApprovedEndState',
      `Bundle rehearsal fingerprint ${fingerprints[0]} does not match the approved catalog reference ${reference.fingerprint}`,
      { rehearsalFingerprint: fingerprints[0], referenceFingerprint: reference.fingerprint },
    );
  }

  // Classify drift against the ACTUAL captured snapshot of the synthetic outdated remote (taken
  // read-only, before the bundle was applied, during the last rehearsal cycle) — never a guess.
  const lastCycle = cycleResults[cycleResults.length - 1];
  const drift = classifyDrift(ledger, migrationSqlByOrder, lastCycle.remoteSnapshot);
  const appVersion = readAppVersion({ fileSystem });
  const bundle = buildSyncBundle(drift.migrations, migrationSqlByOrder, { appVersion });
  const rollbackPlan = buildRollbackPlan(bundle);
  const backfillEstimate = estimateBackfillFromReltuples(lastCycle.reltuplesRows, ['catalogo_eventos_auditoria']);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bundleFiles = [...bundle.phases.expand, ...bundle.phases['backfill-dml'], ...bundle.phases.contract, ...bundle.destructiveBlock]
    .map((item) => ({ path: item.path, sha256: item.sha256 }));
  const approvalForm = buildApprovalForm({
    target: 'SIMULATED remote (local disposable lab standing in for a real Supabase project — no real project ref confirmed; see needs-owner below)',
    commit: process.env.GIT_COMMIT ?? 'needs-owner: fill exact commit SHA at generation time',
    files: bundleFiles,
    window: 'needs-owner: no real remote/maintenance window exists yet',
    impact: `${bundleFiles.length} migration(s) missing on the simulated remote; ${bundle.destructiveBlock.length} destructive item(s) requiring separate approval`,
    backups: 'rehearsed only against the disposable local lab; real backup/restore lab documented in database/README.md is needs-owner for a real project',
    validations: [
      `final pgTAP catalog suite (${lastCycle.finalPgTapStep}) passed against the fully-migrated rehearsal database`,
      `catalog fingerprint stable across ${cycles} rehearsal cycles: ${fingerprints[0]}`,
      `rehearsal fingerprint matches the committed approved reference: database/catalog-reference.json`,
    ],
    abortRollback: JSON.stringify(rollbackPlan, null, 2),
    executor: 'needs-owner',
  });

  if (!fileSystem.existsSync(artifactsRoot)) fileSystem.mkdirSync(artifactsRoot, { recursive: true });
  const outputDir = path.join(artifactsRoot, timestamp);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  const manifest = {
    generatedAt: new Date().toISOString(),
    simulation: true,
    note: 'No real Supabase remote project ref is confirmed. This is a rehearsal against the disposable local lab only.',
    rehearsalCycles: cycles,
    rehearsalFingerprints: fingerprints,
    approvedCatalogReference: reference.fingerprint,
  };
  fileSystem.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fileSystem.writeFileSync(path.join(outputDir, 'drift-report.json'), `${JSON.stringify(drift, null, 2)}\n`, 'utf8');
  fileSystem.writeFileSync(path.join(outputDir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  fileSystem.writeFileSync(path.join(outputDir, 'backfill-estimate.json'), `${JSON.stringify(backfillEstimate, null, 2)}\n`, 'utf8');
  fileSystem.writeFileSync(path.join(outputDir, 'approval-form.md'), approvalForm, 'utf8');

  return ok(Object.freeze({
    outputDir,
    manifest,
    drift,
    bundle,
    rollbackPlan,
    backfillEstimate,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/supabase-sync-rehearsal.mjs')) {
  const result = await generateAndRehearseSyncPackage();
  if (result._tag === 'err') {
    console.error(`[supabase-sync-rehearsal] ${result.error._tag}: ${failureMessage(result.error)}`);
    process.exitCode = 1;
  } else {
    console.log(`[supabase-sync-rehearsal] complete. Artifacts written to ${result.value.outputDir}`);
    console.log(`[supabase-sync-rehearsal] status: awaiting-owner-approval`);
  }
}
