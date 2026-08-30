# ORBITA database ledger

`database/migrations.lock.json` is the canonical laboratory ledger. It records
an explicit ordinal and SHA-256 checksum for every executable SQL file plus a
separate checksum for the immutable `schema_master.sql` reference. Numeric
filename prefixes are descriptive and never decide execution order on their own.

`schema_master.sql` is an immutable legacy reference and is not executable from
an empty database: historical migrations 06–11 were concatenated into it out of
order. The laboratory-only files under `supabase/lab/` reconstruct the valid
empty-database baseline and temporary compatibility contracts. They are not
production migrations and never rewrite or extend deployed history. The real
forward migrations remain under `database/` unchanged.

## Required workflow

1. Add a reviewed forward-only production SQL file under `database/`.
2. Add its exact position to `supabase/config.toml` `schema_paths`.
3. Regenerate the checksum ledger deliberately with `npm run db:ledger:write`.
4. Add behavior pgTAP coverage under `supabase/tests/database/`.
5. If the intended final catalog changed, rebuild the local database, review the
   change, and update `database/catalog-reference.json` with
   `npm run db:catalog:write`.
6. Run `npm run db:drift:check` and `npm run test:db`.

Never edit a potentially applied migration to make the checksum pass. Add a new
forward-only migration and regenerate the ledger after review.

## Applying migrations to a remote database

Merging a pull request publishes code, not SQL. Nothing in this repository
pushes migrations to a hosted Supabase project, and the Supabase GitHub
integration does not cover it either: that integration deploys
`supabase/migrations/`, and these migrations live in `database/`, ordered by
`database/migrations.lock.json`. The directory it looks for does not exist here.

On 2026-08-30 the production database was three migrations behind and a fix was
reported as delivered without existing there. `scripts/migracoes-remotas.mjs`
closes that gap.

```bash
npm run db:remoto:status  -- --url "<connection>"   # read-only, lists what is missing
npm run db:remoto:aplicar -- --url "<connection>" --confirmar
```

The target is never defaulted: without `--url` or `SUPABASE_DB_URL` the script
refuses to run. `--aplicar` without `--confirmar` also refuses. Each migration
runs in its own transaction, so a failure halfway leaves the earlier ones
applied and recorded, and the next run resumes exactly where it stopped.

What has already been applied is recorded in `public.migracoes_aplicadas`,
created by the script itself. It is tool metadata and deliberately outside the
application schema, for the same reason `schema_migrations` is not a migration
in any framework: it has to exist before the first one runs. Because it is not
part of the application schema, it does not affect the catalog fingerprint.

A database that already had migrations applied by hand adopts its state once:

```bash
npm run db:remoto:status -- --url "<connection>" --adotar --confirmar
```

`--adotar` records the whole ledger as applied **without executing anything**.
Using it in any other situation makes the record lie.

If a migration that is already recorded no longer matches its checksum, the
script refuses everything and names the file. Editing an applied migration is
what the ledger exists to forbid; the fix is a new forward-only migration.

## Disposable laboratory

`npm run test:db` is local-only and performs:

- checksum and order preflight before Docker starts;
- preventive teardown so `db start` always creates an empty application schema;
- one injected failure after migration 18 followed by mandatory teardown;
- two independent empty-database rebuilds with one canonical application each;
- 247 migration behavior assertions that run in rollback-only transactions on
  the empty application schema, using canonical SQL expanded only in memory;
- one canonical 1–39 application after the rollback-only historical tests;
- final pgTAP catalog/security assertions through the Supabase CLI;
- exact catalog fingerprint comparison for relations, columns, policies, ACLs,
  owners, functions, constraints, indexes, and triggers;
- teardown with `--no-backup` after every cycle.

The runner forwards PostgreSQL notices through a safe projection, removes
Supabase access tokens from its child environment, and rejects
`--linked`, `--project-ref`, and `--db-url`. It must never be adapted to target a
remote project. It intentionally does not call `supabase db reset`: reset applies
the configured `schema_paths` automatically and would make the later canonical
application a misleading second pass over an already complete schema.

## Failure recovery

If any migration or assertion fails, keep the first error, verify the dedicated
`orbita-database-lab` stack was stopped, correct only a new forward migration or
the laboratory code, and rerun from a fresh empty database. Do not continue from
the partially applied schema and do not restore a lab backup.
