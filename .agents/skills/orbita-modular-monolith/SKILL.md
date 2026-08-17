---
name: orbita-modular-monolith
description: Design and enforce incremental modular-monolith boundaries in ORBITA. Use when adding a domain module, moving services or repositories, defining public module APIs, reducing cross-feature coupling, or preventing Next.js and Supabase details from leaking into domain logic.
---

# ORBITA Modular Monolith

Read `references/boundaries.md`, then:

1. Name the business capability and vocabulary before naming folders.
2. Design the smallest public API that hides the most behavior.
3. Keep domain rules framework- and vendor-independent.
4. Put orchestration in application code and vendor details in adapters.
5. Export cross-module access only from the module root; reject imports from internals.
6. Migrate one vertical slice with tests; do not perform speculative mass moves.
7. Search imports and update Graphify after a boundary changes.
