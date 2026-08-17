# Database rules

- SQL history lives in `database/` with numbered files plus `schema_master.sql`.
- Repository adapters live in `src/repositories`; privileged access starts in `src/lib/supabaseServer.ts`.
- Treat ownership columns and tenant-carrying relationships as security-critical.
- Service role bypasses RLS; every privileged query needs an independently verified tenant/user predicate.
- Add constraints when the invariant is universal and existing data has been assessed.
- Add indexes for foreign keys, tenant filters, ordering, and demonstrated lookup patterns.
- Backfills must be resumable, observable, bounded, and safe to retry.
- Keep schema reference, migration order, repositories, generated types, and tests consistent.
