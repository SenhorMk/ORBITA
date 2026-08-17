---
name: orbita-architecture
description: Map, plan, and review changes against ORBITA's real Next.js, Supabase, Bling, and Chatwoot architecture. Use for cross-cutting features, refactors, dependency-impact analysis, architectural decisions, or when deciding where new ORBITA code belongs.
---

# ORBITA Architecture

1. Read `AGENTS.md` and `references/current-architecture.md`.
2. Query `graphify-out/graph.json` before broad source exploration; regenerate it when absent or stale.
3. Trace the complete behavior: UI or webhook -> route -> service -> repository -> Supabase or external adapter.
4. State current behavior, desired seam, affected files, risks, and verification before editing.
5. Preserve server-only secrets and tenant isolation.
6. Prefer an incremental vertical slice over a repository-wide reorganization.
7. Update the architecture reference when a stable boundary changes.

Use `$orbita-modular-monolith` for module-boundary design and the matching ORBITA domain skill for specialized work.
