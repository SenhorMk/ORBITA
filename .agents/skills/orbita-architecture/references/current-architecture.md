# Current architecture baseline

- Runtime: Next.js App Router, React, TypeScript.
- UI: `src/app`, `src/components`, and `src/components/ui`.
- HTTP boundaries: `src/app/api/**/route.ts`.
- Application and integration logic: `src/services`.
- Persistence adapters: `src/repositories`.
- Supabase and auth: `src/lib/supabaseServer.ts`, `src/lib/supabaseClient.ts`, `src/lib/auth.ts`.
- External contracts: `src/services/bling.ts`, `src/services/chatwoot.ts`, `src/schemas/bling.ts`.
- Database changes: ordered SQL files under `database/`; there is no migration framework.
- Current shape is layered and mostly flat, not yet a modular monolith.

Migrate one cohesive vertical slice at a time. Keep compatibility entry points while callers migrate; remove them only after searches and tests prove no callers remain. Use Graphify as a navigation index, then verify the affected source seam.
