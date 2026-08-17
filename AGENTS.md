# ORBITA development guide

## Canonical repository and history

- The canonical repository is the private repository `SenhorMk/orbita`.
- `SenhorMk/Orbita-legacy` is a read-only historical archive. Never use it as a merge base, copy its Git history, or restore files from it without a ticket-specific review.
- The canonical repository starts from a clean root containing only reviewed files. Never push the legacy refs, tags, branches, secrets, or unreachable objects to it.
- Keep `main` releasable. Product work belongs in a ticket-scoped branch and reaches `main` through a reviewed pull request after the bootstrap publication.
- Never commit `.env*` files except sanitized examples. Development credentials must still be rotated before any public or production deployment if they appeared in legacy history.

## Repository baseline

ORBITA is a TypeScript SaaS built with Next.js App Router, React, Supabase/PostgreSQL, Bling v3, and Chatwoot. The current code is layered but mostly flat. Treat modular-monolith structure as an incremental target, not as the current state.

Before broad exploration, use the project Graphify skill and `graphify-out/graph.json` when available to identify likely dependencies, then verify the affected source. Regenerate the graph after meaningful boundary changes.

## Required workflow

For substantial product work use:

1. `$grill-with-docs` for an unclear idea.
2. `$to-spec` once decisions are aligned.
3. `$to-tickets` for independently verifiable vertical slices.
4. `$implement`, which applies `$tdd` and finishes with `$code-review`.

For a contained bug use `$diagnosing-bugs`, add a regression test, then review. Use `$coding-standards` for TypeScript boundary parsing, typed failures, and safe APIs.

Do not let a workflow skill decide product scope that belongs in the spec. Do not commit or publish tickets unless the user asked for that external state change.

## Ticket execution contract

- Every current and future ticket must be an independently verifiable vertical slice with explicit dependencies, acceptance criteria, security impact, database impact, tests, and rollout/rollback notes where relevant.
- A ticket is not `done` until its acceptance checks have objective evidence from tests, migrations, CI, provider contracts, or an explicitly recorded manual verification.
- Derive actor and tenant identity from a verified server-side session or verified webhook mapping. A client-supplied tenant identifier is never authority.
- Keep ticket status and dependencies synchronized with the implementation. If discovered architecture invalidates the dependency graph, update the plan before coding around it.
- Do not mix unrelated tickets in a commit or pull request. Preserve user-owned local files and generated analysis unless the ticket explicitly includes them.

## ORBITA skills

- `$orbita-architecture`: impact analysis and placement of cross-cutting work.
- `$orbita-modular-monolith`: module boundaries and incremental migrations.
- `$orbita-bling`: every Bling OAuth, API, webhook, and sync change.
- `$orbita-integrations`: Chatwoot and other external adapters.
- `$orbita-security`: auth, permissions, tenant isolation, cookies, secrets, and webhooks.
- `$orbita-database`: Supabase/PostgreSQL schema, RLS, migrations, triggers, and repositories.
- `$supabase`: official Supabase workflow for current product behavior, MCP inspection, CLI safety, and documentation lookup.
- `$supabase-postgres-best-practices`: official query, schema, privilege, RLS, locking, and performance guidance for every PostgreSQL change.
- `$orbita-testing`: test seams and the unit/integration/contract/E2E strategy.
- `$orbita-observability`: structured logs, redaction, request IDs, and audit events.
- `$apple-design`, `$emil-design-eng`, and `$pick-ui-library`: frontend decisions; motion must improve comprehension, feedback, or orientation.
- Do not use `$database-sentinel`; it is disabled for ORBITA until the user explicitly re-enables it. Use the official Supabase skills plus `$orbita-database` and `$orbita-security` instead.
- Strix skills: use only for authorized high-risk/release security work. Local scans require Docker and an LLM provider; never scan a host without confirmation of ownership and scope.

## Architecture rules

- Trace a vertical behavior from UI/webhook through route, service/application logic, repository, database, and provider.
- Keep domain rules independent of Next.js, React, Supabase, and provider SDKs.
- Hide external systems behind adapters and parse untrusted input/output with Zod.
- Cross-module access goes through a small public API. Do not import another module's internals.
- Keep service-role Supabase access server-only. A service role bypasses RLS, so privileged queries must still enforce verified tenant/user scope.
- Prefer deep cohesive modules and explicit dependencies. Do not add pass-through abstractions or mass-move folders without a behavior-preserving slice.

## Security baseline

Target OWASP ASVS 5.0 Level 2. Authenticate and authorize separately; fail closed; verify webhook authenticity before side effects; make webhooks and sync idempotent; never trust tenant IDs supplied only by the client.

Never expose or log passwords, cookies, authorization headers, API keys, Supabase service-role keys, OAuth client secrets, access/refresh tokens, encryption keys, webhook secrets, or raw sensitive payloads.

Essential authentication/security cookies may operate without optional consent but must use narrow secure attributes. Analytics, marketing, and tracking must not load before consent; persist and honor withdrawal.

## Verification gates

Run the narrowest relevant checks during development and all available gates before handoff:

```text
npm test
npm run typecheck
npm run secrets:check
npm run lint:ratchet
npm run aislop
npm run build
```

When a ticket introduces Vitest or Playwright, add the relevant targeted and full test commands to this list. Do not claim tests passed when the repository has no matching automated test runner.

## Database and production safety

Keep SQL changes forward-only and ordered under `database/`. Plan expand/backfill/contract for risky changes. Never run production migrations, backfills, destructive queries, pentests, or credentialed probes without explicit authorization and a rollback/scope statement.

Application and database work ship together as vertical slices. A persistence-affecting ticket must normally include the ordered SQL migration, constraints/indexes/RLS, the server adapter or repository change, contract/integration tests, and the application behavior that consumes it. Do not finish the application first and postpone its database model to a final cleanup phase.

Use the Supabase MCP read-only for inspection by default. Before any remote DDL, DML, backfill, policy change, function deployment, or destructive query, present the exact target, migration, validation query, rollback strategy, and expected lock/data impact, then obtain explicit user approval. Prefer a disposable local Supabase stack or isolated branch before the shared development project.

Service-role access is an exceptional server-side capability, not an authorization mechanism. Every privileged adapter must receive an already verified tenant context and scope every read/write explicitly even when RLS is bypassed.
