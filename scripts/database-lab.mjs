import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SUPABASE_CLI_ENTRY = require.resolve('supabase/dist/supabase.js');

const PROJECT_ID = 'orbita-database-lab';
const DATABASE_DIRECTORY = path.resolve(process.cwd(), 'database');
const GENERATED_INCLUDE_DIRECTORY = path.resolve(
  process.cwd(),
  'supabase',
  'tests',
  'database',
  '.generated',
);

export const DATABASE_LAB_STEPS = Object.freeze([
  Object.freeze({ name: 'start isolated Postgres', args: Object.freeze(['db', 'start']) }),
  Object.freeze({
    name: 'reset local database',
    args: Object.freeze(['db', 'reset', '--local', '--no-seed']),
  }),
  Object.freeze({
    name: 'run pgTAP database tests',
    args: Object.freeze(['test', 'db', '--local']),
  }),
]);

export const DATABASE_LAB_CLEANUP = Object.freeze({
  name: 'destroy isolated Supabase lab',
  args: Object.freeze(['stop', '--project-id', PROJECT_ID, '--no-backup']),
});

/** Resolve the generated pgTAP include path for one canonical SQL file. */
export function generatedIncludePath(fileName) {
  return path.join(
    GENERATED_INCLUDE_DIRECTORY,
    fileName.replace(/\.sql$/i, '.inc'),
  );
}

/**
 * Copy canonical SQL into the test mount without creating duplicate test files.
 *
 * @param {{
 *   mkdirSync?: (directory: string, options: { recursive: true }) => unknown,
 *   readdirSync?: (directory: string) => string[],
 *   copyFileSync?: (source: string, destination: string) => void,
 * }} [operations]
 */
export function prepareDatabaseTestIncludes({
  mkdirSync = fs.mkdirSync,
  readdirSync = fs.readdirSync,
  copyFileSync = fs.copyFileSync,
} = {}) {
  mkdirSync(GENERATED_INCLUDE_DIRECTORY, { recursive: true });

  for (const fileName of readdirSync(DATABASE_DIRECTORY)) {
    if (!fileName.endsWith('.sql')) continue;

    copyFileSync(
      path.join(DATABASE_DIRECTORY, fileName),
      generatedIncludePath(fileName),
    );
  }
}

/** Remove only generated pgTAP includes after the disposable run. */
export function cleanupDatabaseTestIncludes(fileSystem = fs) {
  fileSystem.rmSync(GENERATED_INCLUDE_DIRECTORY, { recursive: true, force: true });
}

const REMOTE_FLAGS = new Set(['--db-url', '--linked', '--project-ref']);
const ALLOWED_SIGNATURES = new Set([
  'db start',
  'db reset --local --no-seed',
  'test db --local',
  `stop --project-id ${PROJECT_ID} --no-backup`,
]);

/**
 * @typedef {object} DatabaseLabStep
 * @property {string} name
 * @property {readonly string[]} args
 */

/**
 * @param {readonly DatabaseLabStep[]} steps
 * @param {DatabaseLabStep} cleanup
 */
export function assertLocalOnlyPlan(
  steps = DATABASE_LAB_STEPS,
  cleanup = DATABASE_LAB_CLEANUP,
) {
  const allSteps = [...steps, cleanup];

  for (const step of allSteps) {
    const signature = step.args.join(' ');
    if (!ALLOWED_SIGNATURES.has(signature)) {
      throw new Error(`Database lab command ${step.name} is not allowlisted: ${signature}`);
    }

    const forbiddenFlag = step.args.find((argument) => REMOTE_FLAGS.has(argument));
    if (forbiddenFlag) {
      throw new Error(`Database lab command ${step.name} contains remote flag ${forbiddenFlag}`);
    }
  }

  for (const step of steps.filter(({ args }) => args.includes('reset') || args.includes('test'))) {
    if (!step.args.includes('--local')) {
      throw new Error(`Database lab command ${step.name} must explicitly target --local`);
    }
  }

  if (!cleanup.args.includes('--no-backup') || !cleanup.args.includes(PROJECT_ID)) {
    throw new Error('Database lab cleanup must delete only the dedicated local project');
  }
}

function localEnvironment() {
  const environment = {
    ...process.env,
    SUPABASE_TELEMETRY_DISABLED: '1',
  };

  delete environment.SUPABASE_ACCESS_TOKEN;
  delete environment.SUPABASE_DB_PASSWORD;

  return environment;
}

export function executeSupabaseStep(step) {
  console.log(`[database-lab] ${step.name}`);

  const result = spawnSync(
    process.execPath,
    [SUPABASE_CLI_ENTRY, ...step.args],
    {
      cwd: process.cwd(),
      env: localEnvironment(),
      stdio: 'inherit',
      shell: false,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Database lab step failed: ${step.name} (exit ${result.status ?? 'unknown'})`);
  }
}

export function runDatabaseLab({
  execute = executeSupabaseStep,
  prepareIncludes = prepareDatabaseTestIncludes,
  cleanupIncludes = cleanupDatabaseTestIncludes,
} = {}) {
  assertLocalOnlyPlan();

  let failure;

  try {
    prepareIncludes();
    for (const step of DATABASE_LAB_STEPS) {
      execute(step);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      execute(DATABASE_LAB_CLEANUP);
    } catch (cleanupError) {
      if (failure) {
        console.error('[database-lab] cleanup also failed', cleanupError);
      } else {
        failure = cleanupError;
      }
    }
    cleanupIncludes();
  }

  if (failure) {
    throw failure;
  }
}
