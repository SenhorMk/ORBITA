import { readFileSync } from 'node:fs';
import path from 'node:path';

import { err, ok } from './script-result.mjs';

/** Fixed final status of every generated approval form. Never `done`/`applied` from this ticket. */
export const APPROVAL_STATUS = 'awaiting-owner-approval';

/** Only host/port this module is ever allowed to build a connection target for — the
 * disposable local Supabase lab already used by `test:db`. Mirrors `assertLocalOnlyTarget`
 * in `backup-restore-lab.mjs`. This ticket deliberately implements no path that can target a
 * real remote: connecting to a real project is `needs-owner` until one is confirmed. */
const ALLOWED_SNAPSHOT_HOST = '127.0.0.1';
const ALLOWED_SNAPSHOT_PORT = 54322;

/**
 * Defense-in-depth guard: refuse to build a "remote snapshot" connection target outside the
 * single disposable local instance this ticket is allowed to touch.
 *
 * @param {string} host
 * @param {number} port
 * @returns {{ readonly _tag: 'ok', readonly value: true } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }}
 */
export function assertSimulatedRemoteTarget(host, port) {
  if (host !== ALLOWED_SNAPSHOT_HOST || port !== ALLOWED_SNAPSHOT_PORT) {
    return err(
      'RealRemoteTargetNotImplemented',
      `This ticket implements no connection to a real remote. Refusing target ${host}:${port}; only the local lab (${ALLOWED_SNAPSHOT_HOST}:${ALLOWED_SNAPSHOT_PORT}) is allowed.`,
      { host, port },
    );
  }
  return ok(true);
}

const DESTRUCTIVE_PATTERN = /\b(drop\s+table|drop\s+column|drop\s+function|truncate)\b/i;
const UNSAFE_DELETE_PATTERN = /delete\s+from\s+[a-z0-9_."]+\s*;/i;

/**
 * Extract the object names a migration's SQL text creates or replaces, per catalog category.
 * Heuristic and intentionally conservative: it is used to detect whether a migration's objects
 * are already observable in a snapshot, not to fully parse SQL. Reused for both the "missing
 * migration" classification and the destructive-block isolation.
 *
 * @param {string} sql - Raw migration SQL.
 * @returns {Readonly<{ tables: ReadonlyArray<string>, functions: ReadonlyArray<string>, policies: ReadonlyArray<string>, indexes: ReadonlyArray<string> }>}
 */
export function parseMigrationObjectRefs(sql) {
  const tables = new Set();
  const functions = new Set();
  const policies = new Set();
  const indexes = new Set();

  for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi)) {
    tables.add(match[1]);
  }
  for (const match of sql.matchAll(/create\s+or\s+replace\s+function\s+(?:public\.)?"?([a-z0-9_]+)"?/gi)) {
    functions.add(match[1]);
  }
  for (const match of sql.matchAll(/create\s+policy\s+"([^"]+)"/gi)) {
    policies.add(match[1]);
  }
  for (const match of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi)) {
    indexes.add(match[1]);
  }

  return Object.freeze({
    tables: Object.freeze([...tables]),
    functions: Object.freeze([...functions]),
    policies: Object.freeze([...policies]),
    indexes: Object.freeze([...indexes]),
  });
}

/**
 * Whether a migration's SQL contains statements that would destroy existing schema/data if
 * applied. Used to force those migrations into an isolated, separately-approved block — never
 * silently inside the general expand/backfill/contract bundle.
 *
 * @param {string} sql
 * @returns {boolean}
 */
export function containsDestructiveStatement(sql) {
  return DESTRUCTIVE_PATTERN.test(sql) || UNSAFE_DELETE_PATTERN.test(sql);
}

/**
 * Classify one migration against a captured catalog snapshot using TABLE creation as the only
 * decision signal: `applied` when every table it creates is observable, `missing` when none
 * are, `partial-conflict` when only some are, and `ambiguous` when the migration creates no new
 * table. Functions, policies and indexes are extracted (see `parseMigrationObjectRefs`) but are
 * deliberately NOT used to decide `applied`/`missing`: by ORBITA's own migration convention
 * (`create or replace function`, `drop policy if exists` + `create policy`) those objects are
 * routinely redefined by later migrations under the same name, so an object existing in the
 * snapshot is not proof that THIS specific migration is the one that produced it. Tables are
 * created once (`create table if not exists`) and never renamed by later migrations in this
 * ledger, so they are the only reliable per-migration signal. A migration that only touches
 * mutable objects is always `ambiguous` — it must be reviewed manually, never assumed either
 * way, matching the ticket's "não resolver apagando remoto" rule.
 *
 * @param {{ tables: ReadonlyArray<string>, functions: ReadonlyArray<string>, policies: ReadonlyArray<string>, indexes: ReadonlyArray<string> }} refs
 * @param {{ relations: ReadonlyArray<{ name: string }>, functions: ReadonlyArray<{ name: string }>, policies: ReadonlyArray<{ policyname: string }>, indexes: ReadonlyArray<{ indexname: string }> }} snapshot
 * @returns {'applied' | 'missing' | 'partial-conflict' | 'ambiguous'}
 */
export function classifyMigrationAgainstSnapshot(refs, snapshot) {
  if (refs.tables.length === 0) return 'ambiguous';
  const relationNames = new Set((snapshot.relations ?? []).map((r) => r.name));
  const found = refs.tables.filter((name) => relationNames.has(name));
  if (found.length === 0) return 'missing';
  if (found.length === refs.tables.length) return 'applied';
  return 'partial-conflict';
}

/**
 * Classify every ledger migration against a captured "remote" snapshot, and flag snapshot
 * objects that are not referenced by any ledger migration (`remote-only`, to preserve — never
 * a reason to drop anything).
 *
 * @param {{ migrations: ReadonlyArray<{ order: number, path: string, sha256: string }> }} ledger
 * @param {ReadonlyArray<string>} migrationSqlByOrder - SQL text, indexed the same as `ledger.migrations`.
 * @param {Readonly<Record<string, unknown>>} snapshot - Captured catalog snapshot (same shape as `captureDatabaseCatalog`'s `snapshot`).
 * @returns {Readonly<{ migrations: ReadonlyArray<Readonly<Record<string, unknown>>>, remoteOnlyRelations: ReadonlyArray<string> }>}
 */
export function classifyDrift(ledger, migrationSqlByOrder, snapshot) {
  const allRefTables = new Set();
  const classified = ledger.migrations.map((migration) => {
    const sql = migrationSqlByOrder[migration.order - 1] ?? '';
    const refs = parseMigrationObjectRefs(sql);
    refs.tables.forEach((t) => allRefTables.add(t));
    const classification = classifyMigrationAgainstSnapshot(refs, snapshot);
    return Object.freeze({
      order: migration.order,
      path: migration.path,
      sha256: migration.sha256,
      refs,
      classification,
      destructive: containsDestructiveStatement(sql),
    });
  });

  const remoteOnlyRelations = (snapshot.relations ?? [])
    .map((r) => r.name)
    .filter((name) => !allRefTables.has(name) && !name.startsWith('pg_'));

  return Object.freeze({
    migrations: Object.freeze(classified),
    remoteOnlyRelations: Object.freeze(remoteOnlyRelations),
  });
}

function derivePhase(migrationPath, destructive) {
  const fileName = path.basename(migrationPath).toLowerCase();
  if (destructive || fileName.includes('contract') || fileName.includes('contrair')) return 'contract';
  if (fileName.includes('backfill')) return 'backfill-dml';
  return 'expand';
}

function estimateLockImpact(sql) {
  if (/alter\s+table[\s\S]*?add\s+column[\s\S]*?not\s+null(?!\s+default)/i.test(sql)) {
    return 'high: ADD COLUMN ... NOT NULL without DEFAULT rewrites the table under ACCESS EXCLUSIVE lock';
  }
  if (/create\s+(?:unique\s+)?index\s+(?!concurrently)/i.test(sql) && !/concurrently/i.test(sql)) {
    return 'medium: CREATE INDEX without CONCURRENTLY briefly blocks writes on the table';
  }
  if (containsDestructiveStatement(sql)) {
    return 'high: destructive statement (DROP/TRUNCATE/unbounded DELETE) — isolated block required';
  }
  return 'low: additive DDL (CREATE ... IF NOT EXISTS / CREATE OR REPLACE FUNCTION), no destructive rewrite expected';
}

/**
 * Build the immutable, phased sync bundle for the migrations classified `missing`. Never
 * includes an `applied` or `ambiguous` migration; destructive migrations are moved into
 * `destructiveBlock`, never the general phases, and always require their own approval.
 *
 * @param {ReadonlyArray<Readonly<Record<string, unknown>>>} classifiedMigrations - Output of `classifyDrift(...).migrations`.
 * @param {ReadonlyArray<string>} migrationSqlByOrder - SQL text, indexed the same as the ledger.
 * @param {{ appVersion?: string }} [options]
 * @returns {Readonly<{ generatedAt: string, appVersion: string, phases: Readonly<Record<'expand' | 'backfill-dml' | 'contract', ReadonlyArray<Readonly<Record<string, unknown>>>>>, destructiveBlock: ReadonlyArray<Readonly<Record<string, unknown>>> }>}
 */
export function buildSyncBundle(classifiedMigrations, migrationSqlByOrder, { appVersion } = {}) {
  const missing = classifiedMigrations.filter((m) => m.classification === 'missing');
  const phases = { expand: [], 'backfill-dml': [], contract: [] };
  const destructiveBlock = [];

  missing.forEach((migration) => {
    const sql = migrationSqlByOrder[migration.order - 1] ?? '';
    const item = Object.freeze({
      order: migration.order,
      path: migration.path,
      sha256: migration.sha256,
      preconditionQuery: `select 1 from pg_catalog.pg_tables where schemaname = 'public' and tablename = ${JSON.stringify(migration.refs.tables[0] ?? '__no_target_table__')} -- expect no row when object not yet applied`,
      lockImpact: estimateLockImpact(sql),
      minAppVersion: appVersion,
      postconditionQuery: `select 1 -- re-run database-catalog capture and confirm fingerprint changed for order ${migration.order}`,
      abortCondition: 'precondition query returns unexpected rows, or the file sha256 no longer matches database/migrations.lock.json',
    });
    if (migration.destructive) {
      destructiveBlock.push(item);
    } else {
      phases[derivePhase(migration.path, false)].push(item);
    }
  });

  return Object.freeze({
    generatedAt: new Date().toISOString(),
    appVersion,
    phases: Object.freeze({
      expand: Object.freeze(phases.expand),
      'backfill-dml': Object.freeze(phases['backfill-dml']),
      contract: Object.freeze(phases.contract),
    }),
    destructiveBlock: Object.freeze(destructiveBlock),
  });
}

/**
 * Resolve the app's minimum compatible version for a bundle from the committed `package.json`
 * — deterministic, no placeholder/guessed value.
 *
 * @param {{ packageJsonPath?: string, fileSystem?: { readFileSync: typeof readFileSync } }} [options]
 * @returns {string}
 */
export function readAppVersion({ packageJsonPath = path.resolve(process.cwd(), 'package.json'), fileSystem = { readFileSync } } = {}) {
  const parsed = JSON.parse(fileSystem.readFileSync(packageJsonPath, 'utf8'));
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json has no version field to derive minAppVersion from');
  }
  return parsed.version;
}

/**
 * Estimate backfill scope from `pg_class.reltuples` (planner's approximate row-count metadata)
 * — never from reading table content. Callers must pass rows already produced by a metadata
 * query such as `select relname, reltuples from pg_class where relkind = 'r'`.
 *
 * @param {ReadonlyArray<{ relname: string, reltuples: number }>} reltuplesRows
 * @param {ReadonlyArray<string>} targetTables - Tables the backfill-dml phase touches.
 * @returns {ReadonlyArray<Readonly<{ table: string, approxRowCount: number, batchSize: number, estimatedBatches: number }>>}
 */
export function estimateBackfillFromReltuples(reltuplesRows, targetTables) {
  const byName = new Map(reltuplesRows.map((row) => [row.relname, Math.max(0, Math.round(Number(row.reltuples)))]));
  const BATCH_SIZE = 5000;
  return Object.freeze(targetTables.map((table) => {
    const approxRowCount = byName.get(table) ?? 0;
    return Object.freeze({
      table,
      approxRowCount,
      batchSize: BATCH_SIZE,
      estimatedBatches: Math.max(1, Math.ceil(approxRowCount / BATCH_SIZE)),
    });
  }));
}

/**
 * Build the fixed rollback policy for a bundle: app-first mitigation, then forward-only fix;
 * restore is named explicitly as a last resort requiring separate authorization. Destructive
 * items are never covered by this generic rollback — they are called out as needing their own
 * approved rollback statement.
 *
 * @param {Readonly<{ destructiveBlock: ReadonlyArray<unknown> }>} bundle
 * @returns {Readonly<Record<string, unknown>>}
 */
export function buildRollbackPlan(bundle) {
  return Object.freeze({
    order: Object.freeze([
      'app-first: disable the feature flag / pause the worker that depends on the new schema; the app must keep working against the pre-bundle schema',
      'forward-only fix: ship a corrective migration appended to the ledger; never edit or reorder an already-applied migration file',
      'restore: last resort only, requires separate authorization from the owner and a fresh backup/restore rehearsal (see database/README.md backup-restore lab) — never implied by this bundle alone',
    ]),
    destructiveItemsRequireOwnApproval: bundle.destructiveBlock.length > 0,
    destructiveItemCount: bundle.destructiveBlock.length,
  });
}

/**
 * Build the approval form markdown. `status` is always `APPROVAL_STATUS`; passing any other
 * value is a programming error, not a configurable option — this ticket must never produce a
 * form that looks approved/applied.
 *
 * @param {{ target: string, commit: string, files: ReadonlyArray<{ path: string, sha256: string }>, window: string, impact: string, backups: string, validations: ReadonlyArray<string>, abortRollback: string, executor: string, status?: string }} context
 * @returns {string}
 */
export function buildApprovalForm(context) {
  if (context.status !== undefined && context.status !== APPROVAL_STATUS) {
    throw new Error(`Approval form status must be "${APPROVAL_STATUS}"; refusing to render status "${context.status}"`);
  }
  const filesList = context.files.map((f) => `- \`${f.path}\` — sha256 \`${f.sha256}\``).join('\n');
  const validationsList = context.validations.map((v) => `- ${v}`).join('\n');
  return [
    '# Supabase sync bundle — approval form',
    '',
    `- **status**: ${APPROVAL_STATUS}`,
    `- **target**: ${context.target}`,
    `- **commit**: ${context.commit}`,
    `- **window**: ${context.window}`,
    `- **impact**: ${context.impact}`,
    `- **backups**: ${context.backups}`,
    `- **executor**: ${context.executor}`,
    '',
    '## Files and checksums',
    '',
    filesList,
    '',
    '## Validations',
    '',
    validationsList,
    '',
    '## Abort / rollback',
    '',
    context.abortRollback,
    '',
  ].join('\n');
}
