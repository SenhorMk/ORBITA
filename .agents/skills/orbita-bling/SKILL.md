---
name: orbita-bling
description: Implement and review ORBITA's Bling API v3 OAuth, resources, webhooks, synchronization, error mapping, rate limits, pagination, idempotency, and contract tests. Use for any change touching Bling routes, services, schemas, tokens, callbacks, webhooks, or sync behavior.
---

# ORBITA Bling

1. Read `references/contract-rules.md` and the relevant section of `docs/BLING_API_V3_DOCUMENTATION.md`.
2. Verify time-sensitive endpoints and limits against current official Bling documentation before changing a contract.
3. Parse every external response at the boundary with Zod; do not cast untrusted payloads.
4. Keep OAuth credentials and bearer tokens server-only and encrypted at rest.
5. Apply an explicit timeout. Retry only transient, idempotent operations with bounded backoff and rate-limit awareness.
6. Make webhook and synchronization writes idempotent and tenant-scoped.
7. Map provider failures to typed internal failures without leaking secrets.
8. Add contract tests for request shape, parsing, pagination, rate limiting, and error mapping.
