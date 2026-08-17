# Adapter contract

Current touchpoints: `src/services/integrationService.ts`, `src/services/chatwoot.ts`, `src/services/sync.ts`, and `src/app/api/chatwoot/**`.

Each operation defines application-facing types, provider schemas, credential scope, timeout/cancellation, rate-limit/retry policy, idempotency key, error mapping, safe telemetry, correlation propagation, and contract tests.

Never let SDK response types become domain types. Never activate hidden mock fallback in production when credentials or provider calls fail; simulation must be explicit and environment-gated.
