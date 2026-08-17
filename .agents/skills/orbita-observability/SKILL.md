---
name: orbita-observability
description: Add and review structured ORBITA access, error, audit, and integration telemetry with request correlation and secret redaction. Use when instrumenting routes, background sync, webhooks, provider calls, failures, performance, or audit-sensitive actions.
---

# ORBITA Observability

Read `references/logging-contract.md`.

1. Accept or generate a request ID at the first trusted server boundary and propagate it through services, repositories, and external calls.
2. Emit structured events with stable names and fields; avoid narrative console strings.
3. Record outcome, duration, status, module, action, and safe actor/tenant identifiers.
4. Separate access, operational error, security, and business audit events.
5. Redact recursively and keep user-facing errors distinct from diagnostics.
6. Do not swallow exceptions. Log once at the ownership boundary and preserve the typed cause.
7. Test redaction and correlation propagation when introducing the shared logger.
