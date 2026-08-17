# Test strategy

- Unit/Vitest: domain rules, validation, transformations, calculations, state transitions.
- Integration: route handlers, auth, repositories, SQL/RPC behavior, adapter composition.
- Contract: Bling, Chatwoot, and future providers; request/response schemas, errors, pagination, rate limits, timeouts, retry eligibility.
- E2E/Playwright: login, registration, main operation, tenant/role permissions, critical integration flow, logout.

Current caveat: JavaScript test tooling is not configured; `tests/e2e.py` and `docs/PLANO_DE_TESTES.md` are legacy/manual assets. Introduce Vitest or Playwright in a scoped ticket with its first valuable test, not as an empty framework-only refactor.

Completion evidence: failing state observed, passing targeted test, passing full gates, and intentionally deferred coverage.
