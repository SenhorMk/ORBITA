# Ticket 20 — Gate ledger

Every gate below is invoked with the **exact same npm script** locally and in CI (`.github/workflows/quality.yml`, job `verify` unless noted). No verification logic is duplicated in YAML — each CI step is a one-line `npm run <script>` call; the script itself lives in `scripts/*.mjs` and is unit-tested where noted.

Runtime: Node.js 22.x (`actions/setup-node@v4`, `node-version: 22`), npm dependency cache keyed by `package-lock.json` (`cache: npm`). Dependencies installed via `npm ci` (locked, reproducible). Local dev matches CI's Node major version (verify with `node -v`).

| Gate | Local command | CI job / step | Runtime | Cache | Artifact | Blocking criterion |
|---|---|---|---|---|---|---|
| Dependency audit | `npm run audit:check` | `verify` / "Audit production dependencies" | Node 22 | npm cache (lockfile) | — | `npm audit --omit=dev --audit-level=high` exits non-zero on any high/critical advisory in production dependencies |
| Secrets (working tree) | `npm run secrets:check` | `verify` / "Check secrets" | Node 22 | npm cache | — | `scripts/check-secrets.mjs` exits 1 if any file matches a credential pattern; tested in `scripts/check-secrets.test.ts` |
| Secrets (commit range) | `npm run secrets:check -- --git-range "<base>..<head>"` | `verify` / "Check secrets in proposed/pushed commits" | Node 22 | npm cache | — | same script, scans the diff of the PR/push range so a secret added then removed still fails; tested in `scripts/check-secrets.test.ts` |
| Database migration ledger/drift | `npm run db:drift:check` | `verify` / "Check database drift" | Node 22 | npm cache | `database/migrations.lock.json` | `scripts/check-database-drift.mjs` exits 1 if any `database/*.sql` file's SHA-256 or ordering differs from the committed ledger; tested in `scripts/check-database-drift.test.ts` |
| Unit/integration tests | `npm test` | `verify` / "Run tests" | Node 22 | npm cache | — | `vitest run` exits non-zero on any failing test (currently 82 files / 519 tests, 0 failing) |
| Typecheck | `npm run typecheck` | `verify` / "Typecheck" | Node 22 | npm cache | — | `tsc --noEmit` exits non-zero on any type error |
| Lint (zero-tolerance) | `npm run lint:ratchet` | `verify` / "Enforce lint gate (zero-tolerance)" | Node 22 | npm cache | — | `scripts/check-lint-ratchet.mjs` runs ESLint over the whole repo and exits 1 on **any** error or warning — no baseline file, no ceiling |
| AI-slop / complexity / duplication (zero-tolerance + documented exceptions) | `npm run aislop` | `verify` / "Enforce AI slop gate" | Node 22 | npm cache | `quality/aislop-allowlist.json` | `scripts/check-aislop-ratchet.mjs` runs `aislop scan` and exits 1 on any diagnostic whose fingerprint is not individually listed in `quality/aislop-allowlist.json` (each entry has an owner, a follow-up ticket, and a date — never a global count ceiling) |
| Module boundaries | `npm run boundaries:check` | `verify` / "Enforce module boundaries" | Node 22 | npm cache | — | `scripts/check-module-boundaries.mjs` exits 1 on any service/repository importing Next.js/React framework internals, or repository importing from services |
| Production build | `npm run build` | `verify` / "Build production bundle" | Node 22 (Next.js 16.3.1 / Turbopack) | npm cache + Next.js build cache | `.next/` | `next build` exits non-zero on a compile, typecheck-during-build, or page-data-collection failure |
| Build artifact allowlist | `npm run build:artifact:check` | `verify` / "Check build artifact allowlist" | Node 22 | npm cache | `.next/` (scanned) | `scripts/check-build-artifact.mjs` exits 1 if `.next/` contains any path fragment from `.env*`, `.agents`, `.codex`, `.scratch`, `graphify-out`, or if a non-public secret variable name (`SUPABASE_SERVICE_ROLE_KEY`, `BLING_CLIENT_SECRET`, etc.) appears as literal text in any file under `.next/static` (client-servable); tested in `scripts/check-build-artifact.test.ts` |
| pgTAP / disposable database lab | `npm run test:db` | `database-lab` job / "Run disposable database lab" | Node 22 | npm cache | disposable local Supabase stack (torn down after run) | `scripts/test-database-lab.mjs` exits non-zero if the local Supabase stack fails to start, migrations fail to apply, or any pgTAP test fails. **Must run in foreground only, never backgrounded**, per repo operating rules |

## CI-only workflow properties (not gates, but required by the ticket)

- **Node/npm locked**: `actions/setup-node@v4` pins `node-version: 22`; `npm ci` installs exactly what `package-lock.json` specifies (fails if the lockfile and `package.json` disagree).
- **Least privilege**: workflow-level `permissions: contents: read` — no write scopes granted anywhere.
- **Concurrency cancel**: `concurrency: { group: quality-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` — a new push to the same ref cancels the previous in-flight run.
- **Timeouts**: `verify` job `timeout-minutes: 20`; `database-lab` job `timeout-minutes: 20`.
- **Secrets before build**: "Check secrets" (working tree) and the commit-range secrets checks run before "Build production bundle" in the `verify` job's step order.
- **No production secrets in the workflow**: the only environment values set in `quality.yml` are synthetic CI-only placeholders (`ci-test-*`, `https://ci-test.supabase.co`), never real credentials.

## Deliberate-failure rehearsals

See `.scratch/orbita-mvp-producao-v2/evidence/20-final-evidence.md` for the full transcript of each gate's live "induce → block → revert" rehearsal (test, typecheck, secrets, lint, aislop, boundaries, migration drift, build). Every rehearsal used a synthetic, clearly-named change (e.g. `deliberateLintFailure`, a synthetic `sk_live_...`-shaped credential, an unregistered `next.config.ts` key) confirmed to produce a non-zero exit code, then reverted in the same turn before moving to the next gate — the working tree carries no trace of any rehearsal.

## Residual warnings (explicit, not a global ceiling)

`quality/aislop-allowlist.json` lists exactly three items, each with an owner, a follow-up-ticket description, and a date:

1. `src/app/page.tsx` — `complexity/file-too-large` (2218 lines vs. 600-line budget). Deferred: splitting the dashboard's remaining tabs into per-tab modules (mirroring `src/components/FinanceiroTab.tsx`) is a dedicated modularization effort on the app's primary authenticated screen, not a mechanical extraction.
2. `src/services/bling.ts` — `complexity/file-too-large` (1183 lines vs. 400-line budget). Deferred: `BlingClient` centralizes OAuth/token-refresh/rate-limit/multi-tenant logic behind private fields; splitting it requires a reviewed TypeScript module/mixin refactor scoped specifically for tenant-isolation and auth correctness (`$orbita-bling`, `$orbita-security`), not a quality-gate-ticket-sized change.
3. `package.json` — `security/dependency-audit-skipped` (`info` severity, never blocking). Environment limitation: aislop's bundled `npm audit` invocation fails with `spawn npm ENOENT` on this Windows shell (missing `shell: true` for the `npm.cmd` shim). The real gate, `npm run audit:check`, runs directly and passes with 0 vulnerabilities.

All other complexity, duplication, hardcoded-URL, and accessibility findings identified in ticket 20's baseline capture (160 aislop diagnostics, 10 ESLint warnings) were fixed for real — see the evidence file for the before/after count per gate.
