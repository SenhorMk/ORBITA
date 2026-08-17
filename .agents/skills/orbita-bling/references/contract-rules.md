# Bling contract rules

Current touchpoints:

- Adapter: `src/services/bling.ts`
- Schemas: `src/schemas/bling.ts`
- Sync: `src/services/sync.ts`
- OAuth: `src/app/api/bling/authorize/route.ts`, `callback/route.ts`
- Webhook and resources: `src/app/api/bling/**`
- Local reference: `docs/BLING_API_V3_DOCUMENTATION.md`

For each operation record: method/path, auth scope, request and response schemas, pagination, timeout, retry eligibility, idempotency, rate-limit handling, internal error mapping, and sanitized telemetry.

Never log authorization headers, client secrets, access or refresh tokens, webhook secrets, or full personal-data payloads.
