import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SUPABASE_CLI_ENTRY = require.resolve('supabase/dist/supabase.js');

const PROJECT_ID = 'orbita-database-lab';

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

export function runDatabaseLab({ execute = executeSupabaseStep } = {}) {
  assertLocalOnlyPlan();

  let failure;

  try {
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
  }

  if (failure) {
    throw failure;
  }
}
