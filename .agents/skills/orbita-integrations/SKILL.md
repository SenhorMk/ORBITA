---
name: orbita-integrations
description: Build and review resilient ORBITA adapters for Chatwoot and future external APIs, including authentication, schemas, timeouts, retries, idempotency, webhooks, error mapping, and contract tests. Use for any non-Bling provider integration or shared integration infrastructure.
---

# ORBITA Integrations

Read `references/adapter-contract.md`. Use `$orbita-bling` for Bling-specific work.

1. Isolate each provider behind an application-facing port with domain vocabulary.
2. Parse configuration at startup and payloads at every boundary.
3. Set deadlines; bound retries to transient, idempotent operations and honor rate limits.
4. Verify webhooks before trusting events and reject replay when supported.
5. Make sync and webhook side effects idempotent and tenant-scoped.
6. Translate provider errors into typed internal errors and keep secrets out of logs.
7. Add contract fixtures/tests and document the verified provider version or documentation date.
