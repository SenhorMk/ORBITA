---
name: orbita-testing
description: Design and implement ORBITA unit, integration, contract, and end-to-end tests with stable behavioral seams. Use when specifying acceptance criteria, adding features, fixing regressions, changing APIs or database behavior, or deciding the minimum effective test suite.
---

# ORBITA Testing

Read `references/test-strategy.md` and use `$tdd` for implementation.

1. Express behavior and failure modes before implementation.
2. Choose the highest stable seam that proves behavior with the fewest mocks.
3. Use unit tests for domain behavior, integration tests for routes/repositories/Supabase, contract tests for providers, and E2E only for critical journeys.
4. Control test data and isolate tenants. Never point automated tests at production.
5. Mock external systems ORBITA does not control; exercise internal boundaries together where practical.
6. Add a regression test before fixing a defect.
7. Run targeted tests, then typecheck, lint, full tests, build, and aislop.
