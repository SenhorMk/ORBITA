# Boundary rules

```text
src/modules/<capability>/
  domain/
  application/
  infrastructure/
  presentation/
  index.ts
```

- `domain` imports no Next.js, Supabase, React, or external SDK.
- `application` depends on explicit ports and domain types.
- `infrastructure` implements ports and owns vendor translation.
- `presentation` adapts HTTP/UI input to application commands.
- `index.ts` is the only cross-module import surface.
- `src/shared` contains genuinely cross-domain primitives, never a miscellaneous dump.
- `src/composition` may wire concrete adapters when introduced.

Keep existing `src/services` and `src/repositories` working while a slice migrates. A refactor is complete only when behavior is preserved and obsolete entry points have no callers.
