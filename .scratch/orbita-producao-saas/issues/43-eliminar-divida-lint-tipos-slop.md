# 43 — Eliminar dívida residual de lint, tipos e AI slop

**What to build:** remover a dívida remanescente de qualidade sem alterar comportamento, permitindo que os gates rodem sem baseline temporária.

**Blocked by:** 42 — Contrair facades e impor limites do monólito modular.

**Status:** ready-for-agent

- [ ] Não restam erros de lint ou typecheck.
- [ ] `any`, casts inseguros, catches silenciosos e duplicações remanescentes são corrigidos ou justificados de forma localizada.
- [ ] Scripts descartáveis e comentários artificiais são removidos ou promovidos a ferramentas mantidas.
- [ ] O ratchet temporário é removido e os gates completos passam.
