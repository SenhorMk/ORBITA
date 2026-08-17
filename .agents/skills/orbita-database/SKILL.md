---
name: orbita-database
description: Design, migrate, and review ORBITA's Supabase/PostgreSQL schema, RLS, constraints, indexes, triggers, RPCs, and repository access. Use for SQL changes, tenant isolation, persistence design, backfills, data integrity, performance, or database security.
---

# ORBITA Database

Read `references/database-rules.md`; use `$database-sentinel` for a security audit.

1. Inspect all ordered SQL files and repository callers affected by the change.
2. Make forward-only, rerunnable migrations where practical; never rewrite deployed history without explicit instruction.
3. Enforce tenant isolation in schema/RLS and server-side queries.
4. Prefer constraints for durable invariants and indexes justified by query shapes.
5. Keep triggers small and deterministic; avoid hidden business workflows.
6. Plan expand/backfill/contract for destructive or large changes.
7. Test authorized, cross-tenant, unauthenticated, invalid, duplicate, and rollback paths.
8. Never execute production DDL, backfills, or probes without explicit authorization and a rollback plan.
