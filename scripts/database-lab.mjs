import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { captureAndValidateDatabaseCatalog } from './database-catalog.mjs';
import { readCanonicalLedger, SUPABASE_CONFIG_PATH, validateCanonicalLedger } from './database-ledger.mjs';
import { createLocalDatabaseClient, DEFAULT_LOCAL_DATABASE_PORT } from './local-database-client.mjs';
import { runMigrationPgTapTests } from './database-pgtap.mjs';
import { err, ok } from './script-result.mjs';

const require = createRequire(import.meta.url);
const SUPABASE_CLI_ENTRY = require.resolve('supabase/dist/supabase.js');
const PROJECT_ID = 'orbita-database-lab';
const FINAL_TEST_PATH = 'supabase/tests/final';

/**
 * Describe one isolated laboratory cycle using only allowlisted local commands.
 *
 * @param {number | string} cycle - Cycle label used in diagnostic output.
 * @returns {ReadonlyArray<Readonly<{ name: string, args: ReadonlyArray<string> }>>} Immutable local command plan.
 */
export function databaseLabCycleSteps(cycle) {
  return Object.freeze([
    Object.freeze({ name: `start isolated Postgres (cycle ${cycle})`, args: Object.freeze(['db', 'start']) }),
    Object.freeze({
      name: `run final catalog pgTAP (cycle ${cycle})`,
      args: Object.freeze(['test', 'db', FINAL_TEST_PATH, '--local']),
    }),
  ]);
}

/** Command that destroys only the dedicated local Supabase laboratory. */
export const DATABASE_LAB_CLEANUP = Object.freeze({
  name: 'destroy isolated Supabase lab',
  args: Object.freeze(['stop', '--project-id', PROJECT_ID, '--no-backup']),
});

const REMOTE_FLAGS = new Set(['--db-url', '--linked', '--project-ref']);
const ALLOWED_SIGNATURES = new Set([
  'db start',
  `test db ${FINAL_TEST_PATH} --local`,
  `stop --project-id ${PROJECT_ID} --no-backup`,
]);

/**
 * Parse a laboratory plan into an allowlisted local-only plan.
 *
 * @param {ReadonlyArray<Readonly<{ name: string, args: ReadonlyArray<string> }>>} [steps] - Commands before cleanup.
 * @param {Readonly<{ name: string, args: ReadonlyArray<string> }>} [cleanup] - Mandatory cleanup command.
 * @returns {{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Parsed plan or a tagged safety failure.
 */
export function parseLocalOnlyPlan(
  steps = databaseLabCycleSteps(1),
  cleanup = DATABASE_LAB_CLEANUP,
) {
  for (const step of [...steps, cleanup]) {
    const signature = step.args.join(' ');
    if (!ALLOWED_SIGNATURES.has(signature)) {
      return err('UnsafeDatabaseLabPlan', `Database lab command ${step.name} is not allowlisted: ${signature}`, { step: step.name });
    }
    const forbiddenFlag = step.args.find((argument) => REMOTE_FLAGS.has(argument));
    if (forbiddenFlag) {
      return err('UnsafeDatabaseLabPlan', `Database lab command ${step.name} contains remote flag ${forbiddenFlag}`, { step: step.name, forbiddenFlag });
    }
  }
  for (const step of steps.filter(({ args }) => args.includes('test'))) {
    if (!step.args.includes('--local')) {
      return err('UnsafeDatabaseLabPlan', `Database lab command ${step.name} must explicitly target --local`, { step: step.name });
    }
  }
  if (!cleanup.args.includes('--no-backup') || !cleanup.args.includes(PROJECT_ID)) {
    return err('UnsafeDatabaseLabPlan', 'Database lab cleanup must delete only the dedicated local project');
  }
  return ok(Object.freeze({ steps, cleanup }));
}

function localEnvironment() {
  const environment = { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' };
  delete environment.SUPABASE_ACCESS_TOKEN;
  delete environment.SUPABASE_DB_PASSWORD;
  return environment;
}

/**
 * Execute one allowlisted Supabase CLI step without a shell.
 *
 * @param {Readonly<{ name: string, args: ReadonlyArray<string> }>} step - Parsed local command.
 * @returns {{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Process outcome.
 */
export function executeSupabaseStep(step) {
  console.log(`[database-lab] ${step.name}`);
  const result = spawnSync(process.execPath, [SUPABASE_CLI_ENTRY, ...step.args], {
    cwd: process.cwd(),
    env: localEnvironment(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    return err('SupabaseStepStartFailed', `Database lab step could not start: ${step.name}`, { step: step.name }, result.error);
  }
  if (result.status !== 0) {
    return err(
      'SupabaseStepFailed',
      `Database lab step failed: ${step.name} (exit ${result.status ?? 'unknown'})`,
      { step: step.name, exitCode: result.status },
    );
  }
  return ok(Object.freeze({ step: step.name }));
}

/**
 * Faz o `auth.users` do laboratório coincidir com o de produção na coluna
 * `email_confirmed_at`.
 *
 * `supabase db start` sobe **só o Postgres**: as migrations do GoTrue não
 * rodam, e o `auth` que sobra é o esqueleto da imagem base — um schema de
 * GoTrue antigo, sem `email_confirmed_at`. No Staging (conferido em
 * 2026-09-09) a coluna existe, é `timestamptz` e não é gerada, e é ela que a
 * migration 64 lê para exigir e-mail **provado** antes de aceitar um convite
 * nominal. Sem este alinhamento o laboratório não consegue executar a função,
 * e o contrato mais sensível do Ticket 06 ficaria sem prova.
 *
 * Duas coisas que isto **não** é:
 *
 * - não é uma migration. O repositório não altera o schema `auth`, que não é
 *   dele; isto é o harness ajustando o próprio laboratório descartável;
 * - não afrouxa o teste. A coluna nasce nula, então quem não for semeado como
 *   confirmado continua sendo recusado — que é exatamente o caso medido.
 *
 * A conexão é a de `supabase_auth_admin` porque `postgres` **não é dono** de
 * `auth.users` no Supabase local (nem superusuário), e a alteração seria
 * negada com `42501`.
 *
 * @param {object} [options] - Fábrica de cliente injetável para teste.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Confirmação ou falha tagueada.
 */
export async function alinharStubDeAuthComProducao({
  createClient = () => createLocalDatabaseClient('orbita-auth-stub', console, DEFAULT_LOCAL_DATABASE_PORT, 'supabase_auth_admin'),
} = {}) {
  const client = createClient();
  try {
    await client.connect();
    await client.query('alter table auth.users add column if not exists email_confirmed_at timestamptz');
    return ok(Object.freeze({ coluna: 'auth.users.email_confirmed_at' }));
  } catch (cause) {
    return err(
      'AuthStubAlignmentFailed',
      'Nao foi possivel alinhar o esqueleto de auth.users do laboratorio com o schema de producao',
      {},
      cause,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Apply every checksum-locked migration in exact ledger order.
 *
 * @param {object} [options] - Injected local database, ledger and filesystem boundaries.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: ReadonlyArray<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Applied ledger entries or a tagged database failure.
 */
export async function applyCanonicalMigrations({
  client = createLocalDatabaseClient('orbita-database-lab'),
  ledgerResult = readCanonicalLedger(),
  failAfterOrder,
  fileSystem = fs,
} = {}) {
  if (ledgerResult._tag === 'err') return ledgerResult;
  const applied = [];
  let outcome;
  try {
    await client.connect();
    for (const migration of ledgerResult.value.migrations) {
      const migrationPath = path.resolve(path.dirname(SUPABASE_CONFIG_PATH), migration.path);
      console.log(`[database-lab] apply ${String(migration.order).padStart(2, '0')} ${migration.path} ${migration.sha256.slice(0, 12)}`);
      const canonicalSql = fileSystem.readFileSync(migrationPath, 'utf8').replace(/^\uFEFF/, '');
      await client.query(canonicalSql);
      applied.push(migration);
      if (migration.order === failAfterOrder) {
        outcome = err(
          'MigrationFailureInjected',
          `injected migration failure after order ${failAfterOrder}`,
          { failAfterOrder, appliedMigrations: applied.length },
        );
        break;
      }
    }
    outcome ??= ok(Object.freeze(applied));
  } catch (cause) {
    outcome = err(
      'MigrationApplyFailed',
      `Canonical migration application failed after ${applied.length} migrations`,
      { appliedMigrations: applied.length },
      cause,
    );
  } finally {
    try {
      await client.end();
    } catch (cause) {
      if (outcome?._tag !== 'err') outcome = err('MigrationClientCleanupFailed', 'Could not close the local migration database client', {}, cause);
    }
  }
  return outcome;
}

function safeFailure(error) {
  if (!error || typeof error !== 'object') return Object.freeze({ tag: 'UnknownFailure', message: String(error) });
  return Object.freeze({
    tag: typeof error._tag === 'string' ? error._tag : 'UnknownFailure',
    message: typeof error.message === 'string' ? error.message : 'No safe failure message was provided',
  });
}

async function runCycle({ cycle, execute, runMigrationTests, applyMigrations, captureCatalog, alinharAuth }) {
  const [start, finalTests] = databaseLabCycleSteps(cycle);
  let outcome;
  try {
    outcome = await execute(start);
    // O esqueleto de `auth` sobe com o Postgres e fica para tras do schema real;
    // alinha-lo e pre-requisito de qualquer teste que execute a aceitacao de
    // convite. Vem antes do pgTAP, que e quem precisa dele.
    if (outcome._tag === 'ok') outcome = await alinharAuth();
    if (outcome._tag === 'ok') outcome = await runMigrationTests();
    if (outcome._tag === 'ok') outcome = await applyMigrations();
    if (outcome._tag === 'ok') outcome = await execute(finalTests);
    if (outcome._tag === 'ok') outcome = await captureCatalog();
  } catch (cause) {
    outcome = err('UnexpectedDatabaseLabFailure', `Unexpected failure during database lab cycle ${cycle}`, { cycle }, cause);
  } finally {
    let cleanup;
    try {
      cleanup = await execute(DATABASE_LAB_CLEANUP);
    } catch (cause) {
      cleanup = err('DatabaseLabCleanupFailed', `Database lab cleanup threw after cycle ${cycle}`, { cycle }, cause);
    }
    if (cleanup._tag === 'err') {
      outcome = err(
        'DatabaseLabCleanupFailed',
        `Database lab cleanup failed after cycle ${cycle}`,
        {
          cycle,
          primaryFailure: outcome?._tag === 'err' ? safeFailure(outcome.error) : undefined,
          cleanupFailure: safeFailure(cleanup.error),
        },
      );
    }
  }
  return outcome ?? err('UnexpectedDatabaseLabFailure', `Database lab cycle ${cycle} produced no outcome`, { cycle });
}

/**
 * Prove that a failure in the middle of the chain still destroys the laboratory.
 *
 * @param {object} options - Injected process and migration boundaries.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Rehearsal evidence or tagged failure.
 */
export async function runFailureRehearsal({ execute, applyMigrations, failAfterOrder = 18 }) {
  const [start] = databaseLabCycleSteps('failure rehearsal');
  let outcome;
  let cleanup;
  try {
    outcome = await execute(start);
    if (outcome._tag === 'ok') outcome = await applyMigrations({ failAfterOrder });
  } catch (cause) {
    outcome = err('UnexpectedFailureRehearsalError', 'Unexpected failure during database failure rehearsal', { failAfterOrder }, cause);
  } finally {
    try {
      cleanup = await execute(DATABASE_LAB_CLEANUP);
    } catch (cause) {
      cleanup = err('DatabaseLabCleanupFailed', 'Database failure rehearsal cleanup threw', { failAfterOrder }, cause);
    }
  }
  if (cleanup?._tag === 'err') {
    return err(
      'DatabaseLabCleanupFailed',
      'Database failure rehearsal cleanup failed',
      {
        primaryFailure: outcome?._tag === 'err' ? safeFailure(outcome.error) : undefined,
        cleanupFailure: safeFailure(cleanup.error),
      },
    );
  }
  if (outcome?._tag !== 'err' || outcome.error._tag !== 'MigrationFailureInjected') {
    return err('FailureRehearsalInvalid', 'Database failure rehearsal did not observe the expected injected migration failure', { failAfterOrder });
  }
  return ok(Object.freeze({ failAfterOrder, teardown: 'complete' }));
}

/**
 * Run the complete local-only migration laboratory and compare clean rebuilds.
 *
 * @param {object} [options] - Injected adapter boundaries and cycle settings.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: { readonly catalogFingerprint: string, readonly cycles: number } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Reproducibility evidence or tagged failure.
 */
export async function runDatabaseLab({
  execute = executeSupabaseStep,
  runMigrationTests = runMigrationPgTapTests,
  applyMigrations = applyCanonicalMigrations,
  captureCatalog = captureAndValidateDatabaseCatalog,
  alinharAuth = alinharStubDeAuthComProducao,
  validateLedger = validateCanonicalLedger,
  cycles = 2,
  rehearseFailure = false,
} = {}) {
  const plan = parseLocalOnlyPlan();
  if (plan._tag === 'err') return plan;
  const validation = validateLedger();
  if (validation._tag === 'err') return validation;
  let initialCleanup;
  try {
    initialCleanup = await execute(DATABASE_LAB_CLEANUP);
  } catch (cause) {
    initialCleanup = err('DatabaseLabCleanupFailed', 'Initial database laboratory cleanup threw', {}, cause);
  }
  if (initialCleanup._tag === 'err') return initialCleanup;
  if (rehearseFailure) {
    const rehearsal = await runFailureRehearsal({ execute, applyMigrations });
    if (rehearsal._tag === 'err') return rehearsal;
  }

  const fingerprints = [];
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const cycleResult = await runCycle({ cycle, execute, runMigrationTests, applyMigrations, captureCatalog, alinharAuth });
    if (cycleResult._tag === 'err') return cycleResult;
    fingerprints.push(cycleResult.value);
  }
  if (new Set(fingerprints).size !== 1) {
    return err('CatalogRebuildDrift', `Catalog drift between clean cycles: ${fingerprints.join(' != ')}`, { fingerprints });
  }
  return ok(Object.freeze({ catalogFingerprint: fingerprints[0], cycles }));
}
