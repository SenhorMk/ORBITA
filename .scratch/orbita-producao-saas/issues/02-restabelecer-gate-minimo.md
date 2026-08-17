# 02 — Restabelecer o gate mínimo de engenharia

**What to build:** devolver ao time um ciclo confiável no qual typecheck e build passam, um teste útil de autenticação roda localmente e nova dívida de lint ou AI slop não cresce.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] O erro de typecheck atual é reproduzido antes da correção e deixa de ocorrer depois dela.
- [x] O runner de testes nasce junto de um teste comportamental útil no seam de autenticação.
- [x] Typecheck, teste direcionado e build passam localmente.
- [x] Lint e AI slop possuem baseline/ratchet explícito, sem mascarar regressões novas.
