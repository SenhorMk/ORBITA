# ORBITA Supabase forensic audit

Audit date: 2026-08-17
Mode: strictly read-only, Supabase MCP only
Mutation status: none performed
SQL enforcement verified: `transaction_read_only = on`

## Executive summary

The project has RLS enabled on every public application table, but several policies effectively disable tenant isolation. The highest-risk conditions are:

- Four financial/supplier tables allow unrestricted reads and writes through `USING (true)` and `WITH CHECK (true)`.
- A `SECURITY DEFINER` function is executable by `PUBLIC`/`anon`, mutates data, performs no `auth.uid()` check, and has a mutable `search_path`.
- All Chatwoot records are shared among every authenticated user because those tables have no tenant key and authorize based only on `auth.role()`.
- The `anon` role has broad table privileges, including `TRUNCATE`; RLS does not protect `TRUNCATE`.
- Tenant ownership is nullable in financial data already present.
- Several public RPCs accept caller-supplied tenant identifiers without checking them against `auth.uid()`.

No row-level business data, identities, bucket names, credentials, tokens, secrets, or sensitive function literals are included below.

## 1. Verified inventory

### Environment

| Property | Verified value |
|---|---|
| PostgreSQL | 17.6 |
| Database | `postgres` |
| Session/current user | `supabase_read_only_user` |
| Transaction mode | Read-only |
| Session search path | `"$user", public` |
| Public application tables | 19 |
| Public views | 1 |
| Public materialized views | 0 |
| Public functions | 14 |
| Application triggers | 23 |
| Storage buckets | 0 total; 0 public; 0 private |
| MCP migration records | 0 |

### Public tables

Counts below are catalog estimates unless otherwise indicated.

| Table | Est. rows | Columns | RLS | Forced | Policies | Indexes | Tenant key |
|---|---:|---:|---|---|---:|---:|---|
| `categorias` | 4 | 7 | Yes | No | 1 | 2 | Required |
| `categorias_financeiras` | 0* | 7 | Yes | No | 1 | 2 | Nullable |
| `chatwoot_contacts` | 0 | 6 | Yes | No | 1 | 1 | Missing |
| `chatwoot_conversations` | 0 | 8 | Yes | No | 1 | 2 | Missing |
| `chatwoot_messages` | 0 | 8 | Yes | No | 1 | 2 | Missing |
| `clientes` | 9 | 10 | Yes | No | 1 | 4 | Required |
| `configuracao_bling` | 0 | 8 | Yes | No | 0 | 1 | Missing |
| `contas_financeiras` | 0 | 11 | Yes | No | 1 | 3 | Nullable |
| `financeiro` | 0 | 10 | Yes | No | 1 | 1 | Required |
| `fornecedores` | 0 | 15 | Yes | No | 1 | 3 | Missing |
| `integracoes_bling` | 1 | 10 | Yes | No | 4 | 2 | Required |
| `itens_pedido` | 0* | 7 | Yes | No | 1 | 4 | Required |
| `movimentacao_estoque` | 0 | 8 | Yes | No | 1 | 1 | Required |
| `nfe` | 0 | 9 | Yes | No | 0 | 2 | Missing |
| `nfes` | 0 | 8 | Yes | No | 1 | 5 | Required |
| `pedidos` | 0* | 15 | Yes | No | 1 | 5 | Required |
| `produtos` | 17 | 13 | Yes | No | 1 | 4 | Required |
| `sync_state` | 8 | 4 | Yes | No | 1 | 1 | Required |
| `titulos_financeiros` | 1* | 14 | Yes | No | 1 | 8 | Nullable |

\* Catalog estimates can lag. MCP table metadata reported six rows in `categorias_financeiras`, two tenant-null rows in `titulos_financeiros`, and one row each in `pedidos` and `itens_pedido`.

Exact column types, defaults, PKs, checks, FKs, unique constraints, and index definitions were inspected through `pg_catalog`. Important structural facts are incorporated into the findings below.

### Policies

There are 20 public policies and no `storage.objects` policies.

Tenant-scoped `ALL` policies correctly compare `auth.uid()` to `user_id` on:

- `categorias`
- `clientes`
- `financeiro`
- `itens_pedido`
- `movimentacao_estoque`
- `nfes`
- `pedidos`
- `produtos`
- `sync_state`

`integracoes_bling` has one tenant-scoped `ALL` policy plus redundant `SELECT`, `INSERT`, and `UPDATE` policies. Its explicit `UPDATE` policy has no `WITH CHECK`, although the overlapping `ALL` policy supplies a tenant check.

Unrestricted `ALL` policies exist on:

- `categorias_financeiras`
- `contas_financeiras`
- `fornecedores`
- `titulos_financeiros`

Role-only Chatwoot policies exist on all three Chatwoot tables.

RLS-enabled tables with zero public policies:

- `configuracao_bling`
- `nfe`

This is fail-closed for ordinary PostgREST roles, though table owners and service-role access bypass RLS.

### Functions and RPCs

All 14 functions are owned by `postgres` and use PL/pgSQL.

Security-definer functions:

- `acquire_bling_token_lock(uuid, integer)` — mutable search path; public/anonymous executable; mutating; no caller identity validation detected.
- `unlock_sync(uuid)` — fixed `search_path=public`; executable only by `service_role`; no `auth.uid()` check.

Other externally relevant functions:

- `dashboard_stats(uuid)` — authenticated/service-role executable; caller-supplied tenant; no `auth.uid()` validation.
- `rpc_criar_pedido_manual(uuid, uuid, text, text, text, numeric, jsonb)` — authenticated/service-role executable; mutating; caller-supplied tenant; no `auth.uid()` validation.
- `decrement_estoque(uuid, integer)` — public/anonymous executable; mutating; no caller or tenant validation.
- Advisory lock/unlock functions accept caller-supplied user IDs without identity validation.

Function definitions were examined only through derived behavioral checks. Literals were not returned.

### Views

`v_estoque_disponivel`:

- Ordinary view owned by `postgres`
- `security_invoker=true`
- `security_barrier=false`
- Accessible to `anon`, `authenticated`, and `service_role`
- No materialized views discovered

The security-invoker setting is a passing control because underlying RLS remains applicable.

### Triggers

Twenty-three active application triggers were found. Notable duplication:

- `clientes`: three `updated_at`/validation overlaps, including two deletion-validation triggers with near-identical names.
- `itens_pedido`: two stock-update triggers, two `updated_at` triggers, plus validation.
- `pedidos`, `produtos`, and `sync_state`: duplicate `updated_at` implementations.
- All inspected trigger functions are invoker-security, not security-definer.

### Extensions

Installed:

- `plpgsql`
- `pgcrypto`
- `pg_stat_statements`
- `uuid-ossp`
- `pg_cron`
- `supabase_vault`

Other extensions returned by the MCP catalog were available but not installed.

## 2. Findings

## CRITICAL

### C-1 — Unrestricted financial and supplier RLS policies

**Resources:** `categorias_financeiras`, `contas_financeiras`, `fornecedores`, `titulos_financeiros`

**Risk:** Any role with table access can read, insert, modify, or delete every row. This creates direct cross-tenant disclosure and corruption exposure. `fornecedores` cannot be tenant-isolated at all because it lacks `user_id`.

**Proof:** Each table has a permissive `ALL` policy assigned to `public` with both:

```text
USING (true)
WITH CHECK (true)
```

`anon` and `authenticated` also possess broad table privileges.

**Remediation:**

1. Add a non-null `user_id` tenant FK to `fornecedores`.
2. Backfill and validate nullable tenant columns.
3. Replace each unrestricted `ALL` policy with command-specific policies restricted to `authenticated`.
4. Require `(select auth.uid()) = user_id` in both `USING` and `WITH CHECK`.
5. Revoke unnecessary `anon` table privileges.
6. Introduce tenant-aware composite FKs for relationships between these tables.

### C-2 — Anonymous, mutable `SECURITY DEFINER` function

**Resource:** `public.acquire_bling_token_lock(uuid, integer)`

**Risk:** An anonymous caller can execute owner-privileged mutating logic using an arbitrary user ID. Its unfixed `search_path` also permits object-resolution attacks if any attacker-controlled schema can precede trusted objects.

**Proof:**

- `SECURITY DEFINER = true`
- Owner: `postgres`
- Executable by `PUBLIC`, `anon`, `authenticated`, and `service_role`
- Mutating statements detected
- Tenant parameter referenced
- No `auth.uid()` check detected
- No function-level `search_path` setting

**Remediation:**

```text
REVOKE EXECUTE ... FROM PUBLIC, anon;
```

Then restrict execution to the minimum server-only role, set a hardened empty or catalog-qualified search path, schema-qualify every referenced object, and verify tenant/user scope inside the function before any side effect.

### C-3 — Anonymous role has non-RLS-protected destructive privileges

**Resource:** all public tables

**Risk:** The `anon` role reports `TRUNCATE`, `REFERENCES`, and `TRIGGER` in addition to CRUD privileges. PostgreSQL RLS does not apply to `TRUNCATE`. Even where PostgREST does not expose that statement directly, retaining the privilege violates least privilege and increases impact if credentials or another SQL execution path are compromised.

**Proof:** `has_table_privilege` returned the complete privilege set for `anon` on every public table.

**Remediation:** Revoke `TRUNCATE`, `REFERENCES`, and `TRIGGER` from `anon` and `authenticated`; revoke write privileges on tables that should only be changed through controlled server workflows. Retain only endpoint-required privileges.

## HIGH

### H-1 — Chatwoot data shared across every authenticated user

**Resources:** `chatwoot_contacts`, `chatwoot_conversations`, `chatwoot_messages`

**Risk:** Any authenticated ORBITA user can access all contacts, conversations, and message content, and potentially modify them. These tables include direct identity/contact fields and message contents.

**Proof:**

- No table has `user_id` or another verified tenant key.
- Each permissive `ALL` policy allows `auth.role() = authenticated OR service_role`.
- No ownership, account, inbox, or tenant comparison appears in the policies.
- `WITH CHECK` is absent.

**Remediation:** Add an immutable tenant/account key to the Chatwoot hierarchy; backfill it from a trusted server-side mapping; enforce non-null tenant ownership; create tenant-aware FKs; and replace role-only policies with command-specific tenant policies including write checks.

### H-2 — Public anonymous stock mutation function

**Resource:** `public.decrement_estoque(uuid, integer)`

**Risk:** An anonymous caller can request inventory mutation by product identifier without caller identity or tenant verification.

**Proof:**

- Executable by `PUBLIC` and `anon`
- Mutating function
- Accepts product ID and quantity
- No `auth.uid()` check
- No tenant-column behavior detected

**Remediation:** Revoke execution from `PUBLIC` and `anon`. Require authenticated/server-only execution and derive tenant identity from the verified session rather than a supplied identifier. Verify the target product belongs to that tenant before mutation.

### H-3 — RPCs trust caller-supplied tenant IDs

**Resources:** `dashboard_stats(uuid)`, `rpc_criar_pedido_manual(...)`, advisory lock helpers

**Risk:** Authenticated callers can nominate another user's UUID. RLS may protect some underlying operations, but it is not a sufficient contract for functions operating on unrestricted financial tables or later changed to definer security.

**Proof:**

- Functions accept `p_user_id`.
- Their definitions reference tenant columns.
- No comparison between the parameter and `auth.uid()` was detected.
- `dashboard_stats` and `rpc_criar_pedido_manual` are executable by `authenticated`.
- The order RPC performs writes.

**Remediation:** Remove public tenant parameters where possible and derive the tenant from `(select auth.uid())`. Otherwise reject when the parameter differs. Explicitly scope every query and mutation, and add contract tests proving cross-tenant calls fail.

### H-4 — Tenant ownership is nullable and missing in existing rows

**Resources:** `categorias_financeiras`, `titulos_financeiros`, `contas_financeiras`

**Risk:** Tenantless financial records cannot be safely isolated. If restrictive policies are introduced without first resolving ownership, data may either remain exposed or become inaccessible.

**Proof:**

- `categorias_financeiras.user_id`: nullable; 6 tenant-null rows.
- `titulos_financeiros.user_id`: nullable; 2 tenant-null rows.
- `contas_financeiras.user_id`: nullable.
- Their current policies are unrestricted.

**Remediation:** Establish ownership using trusted server-side provenance, quarantine ambiguous records, backfill, validate a `NOT NULL` constraint, then deploy restrictive RLS. Do not infer tenant ownership from client input.

## MEDIUM

### M-1 — Global external-ID uniqueness conflicts with multi-tenancy

**Resources:** `categorias_financeiras`, `contas_financeiras`, `fornecedores`, `titulos_financeiros`, legacy `nfe`

**Risk:** Global unique constraints on external IDs prevent different tenants from storing identical provider IDs and reveal cross-tenant existence through uniqueness failures.

**Proof:** Unique indexes constrain `bling_id` alone rather than `(user_id, bling_id)`. `fornecedores` and `nfe` lack tenant ownership entirely.

**Remediation:** After tenant backfill, replace global uniqueness with tenant-scoped uniqueness. Preserve temporary compatibility during an expand/backfill/contract migration.

### M-2 — Legacy duplicate invoice models

**Resources:** `nfe`, `nfes`

**Risk:** Two near-equivalent invoice tables create ambiguous ownership, policy, and integration behavior. `nfes` is tenant-scoped; `nfe` lacks `user_id` and has zero policies.

**Proof:** Both relate to `pedidos` and contain external invoice identifiers, but they have different tenant and RLS-policy designs.

**Remediation:** Identify the canonical model, migrate references through a forward-only plan, preserve necessary historical data, and retire the legacy object only after application and integrity verification.

### M-3 — Duplicate FKs with contradictory actions

**Resources:**

- `pedidos.cliente_id`
- `itens_pedido.produto_id`
- `chatwoot_conversations.contact_id`

**Risk:** Duplicate constraints add write overhead and create ambiguous deletion behavior. The duplicates include conflicting actions such as `CASCADE` versus `RESTRICT`, and `CASCADE` versus `SET NULL`.

**Proof:** Catalog grouping found two FKs on each identical child-column set. In Chatwoot, `contact_id` is non-null while one FK specifies `SET NULL`.

**Remediation:** Decide the intended lifecycle behavior, retain one constraint per relationship, verify existing data, and remove redundant constraints through an ordered migration.

### M-4 — Redundant permissive policies on `integracoes_bling`

**Resource:** `integracoes_bling`

**Risk:** Four permissive policies are OR-combined. The `ALL` policy makes the three command-specific policies redundant, and the explicit `UPDATE` policy has no `WITH CHECK`. Future edits to one policy can silently weaken the combined result.

**Proof:** One tenant-scoped `ALL` policy overlaps `SELECT`, `INSERT`, and `UPDATE`; all are permissive.

**Remediation:** Replace the set with one policy per required command, using the same tenant predicate and explicit `WITH CHECK` for writes.

### M-5 — Redundant triggers may duplicate side effects

**Resources:** `clientes`, `itens_pedido`, `pedidos`, `produtos`, `sync_state`

**Risk:** Multiple triggers fire for the same event. Duplicate timestamp updates waste work; duplicate deletion checks and inventory triggers can produce inconsistent errors or double accounting if their behavior overlaps.

**Proof:** Twenty-three active triggers include multiple `BEFORE UPDATE` timestamp triggers and two near-identical customer-deletion triggers.

**Remediation:** Compare trigger behavior, choose one canonical implementation per concern, add regression tests, then remove duplicates in a behavior-preserving migration.

### M-6 — Sensitive legacy configuration table lacks tenant ownership

**Resource:** `configuracao_bling`

**Risk:** The table contains OAuth/client credential columns but has no tenant key. Zero RLS policies currently fail closed to ordinary API roles, but service-role or owner access remains global, and future permissive policy changes would expose all configurations.

**Proof:** Sensitive credential columns exist; `user_id` is absent; RLS is enabled with zero policies.

**Remediation:** Prefer a server-only integration-token repository keyed by verified tenant, encrypt sensitive values at rest, expose no direct client-table access, and retire the legacy table if `integracoes_bling` is canonical.

## LOW

### L-1 — RLS is not forced

**Resource:** all public tables

**Risk:** Owners and roles with `BYPASSRLS` can bypass policies. This matters for privileged functions and administrative paths.

**Proof:** `relforcerowsecurity=false` for all 19 public tables.

**Remediation:** Evaluate `FORCE ROW LEVEL SECURITY` for application-owned tables, while ensuring carefully scoped server workflows remain functional. Service-role code must enforce tenant scope independently because service-role access bypasses RLS.

### L-2 — Unindexed foreign keys

Catalog checks found missing supporting indexes for relationships including:

- `nfe.pedido_id`
- `produtos.categoria_id`
- several `user_id` FKs
- `movimentacao_estoque.produto_id`
- `financeiro.pedido_id`

**Risk:** Parent deletes/updates and tenant joins may degrade as tables grow.

**Remediation:** Add indexes only after verifying workload and removing duplicate constraints. Prefer composite indexes beginning with `user_id` where queries and relationships are tenant-scoped.

### L-3 — Public execution on trigger-only helper functions

Several trigger helpers retain default `PUBLIC` execution.

**Risk:** Most will fail outside trigger context, but unnecessary exposure expands the callable surface.

**Remediation:** Revoke `PUBLIC`/`anon` execution from internal trigger functions and grant only where explicitly required.

## 3. Passing controls

- The entire audit session was database-enforced read-only.
- All 19 public application tables have RLS enabled.
- Core tenant tables use `auth.uid()` against `user_id`.
- Tenant-policy expressions use the scalar subquery form `(SELECT auth.uid())`, avoiding repeated per-row evaluation.
- No policy uses `user_metadata` for authorization.
- Core Bling entities use tenant-scoped external-ID uniqueness:
  - `categorias`
  - `clientes`
  - `pedidos`
  - `produtos`
  - `nfes`
- `sync_state` has a composite `(user_id, entidade)` primary key.
- `v_estoque_disponivel` has `security_invoker=true`.
- No storage buckets exist and `storage.objects` has zero custom policies.
- Aggregate checks found:
  - zero tested orphan FK rows;
  - zero tested cross-tenant child/parent mismatches;
  - zero within-tenant duplicate external IDs;
  - zero external IDs currently shared across multiple tenants.
- Trigger functions are not security-definer.
- No function definition was found using authorization from user metadata.
- No dynamic SQL was detected in public functions.

## 4. Migration history and drift

`list_migrations` returned an empty migration history, while the live database contains:

- 19 public application tables;
- 20 public policies;
- 14 public functions;
- 1 view;
- 23 triggers;
- numerous constraints and indexes.

Therefore, the live schema is not traceable through the MCP migration ledger. This may mean the schema was created through the dashboard, raw SQL, an external migration mechanism, or migration history was not recorded.

Because repository access was expressly forbidden, this audit cannot compare the live schema against checked-in SQL. The safe conclusion is:

> Migration provenance is unverified; substantial live schema exists despite an empty MCP migration history.

Recommended remediation is to generate a sanitized declarative baseline, compare it with the repository migration directory, establish an authoritative forward-only migration chain, and avoid retroactively marking migrations as applied until the live definitions are reviewed.

## 5. Compact JSON summary

```json
{
  "tables": {
    "public_count": 19,
    "all_rls_enabled": true,
    "all_rls_forced": false,
    "zero_policy": ["configuracao_bling", "nfe"],
    "unrestricted_policy": [
      "categorias_financeiras",
      "contas_financeiras",
      "fornecedores",
      "titulos_financeiros"
    ],
    "missing_tenant_key": [
      "chatwoot_contacts",
      "chatwoot_conversations",
      "chatwoot_messages",
      "configuracao_bling",
      "fornecedores",
      "nfe"
    ]
  },
  "policies": {
    "public_count": 20,
    "storage_objects_count": 0,
    "using_true_count": 4,
    "with_check_true_count": 4,
    "user_metadata_authz_count": 0,
    "multiple_permissive_tables": ["integracoes_bling"]
  },
  "functions": {
    "public_count": 14,
    "security_definer": [
      "acquire_bling_token_lock(uuid,integer)",
      "unlock_sync(uuid)"
    ],
    "public_or_anon_mutating": [
      "acquire_bling_token_lock(uuid,integer)",
      "decrement_estoque(uuid,integer)"
    ],
    "mutable_search_path_security_definer": [
      "acquire_bling_token_lock(uuid,integer)"
    ],
    "caller_tenant_without_auth_uid_check": [
      "acquire_bling_token_lock(uuid,integer)",
      "dashboard_stats(uuid)",
      "rpc_criar_pedido_manual(...)",
      "try_advisory_lock_sync(uuid)",
      "advisory_unlock_sync(uuid)",
      "unlock_sync(uuid)"
    ]
  },
  "views": {
    "count": 1,
    "security_invoker": ["v_estoque_disponivel"],
    "materialized_count": 0
  },
  "triggers": {
    "count": 23,
    "duplicate_or_overlapping_detected": true,
    "affected_tables": [
      "clientes",
      "itens_pedido",
      "pedidos",
      "produtos",
      "sync_state"
    ]
  },
  "storage": {
    "bucket_total": 0,
    "public": 0,
    "private": 0,
    "objects_policy_count": 0
  },
  "data_quality_aggregates": {
    "null_tenant": {
      "categorias_financeiras": 6,
      "titulos_financeiros": 2,
      "all_other_checked_tables": 0
    },
    "duplicate_external_id_within_tenant": 0,
    "external_id_shared_across_tenants": 0,
    "orphans_checked": 0,
    "cross_tenant_fk_mismatches_checked": 0
  },
  "findings": {
    "CRITICAL": 3,
    "HIGH": 4,
    "MEDIUM": 6,
    "LOW": 3
  },
  "limitations": [
    "Supabase advisor endpoint was not exposed; checks were reproduced from catalogs",
    "MCP migration history was empty",
    "No repository comparison was permitted",
    "Catalog row estimates may be stale",
    "Function literals and sensitive definitions were intentionally redacted",
    "No dynamic, mutation, credentialed, or exploit probes were performed",
    "Cross-tenant checks are impossible where tables lack tenant keys"
  ]
}
```
