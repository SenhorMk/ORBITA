# 15 — Inicializar banco vazio e detectar drift no CI

**What to build:** permitir que um banco vazio nasça exclusivamente da baseline aprovada e bloquear divergências não rastreadas entre Git e staging.

**Blocked by:** 14 — Reconstruir a baseline canônica do banco.

**Status:** ready-for-agent

- [ ] O bootstrap de banco vazio conclui sem intervenção manual.
- [ ] O schema resultante corresponde ao estado esperado em staging.
- [ ] O ledger de migrations passa a ser autoritativo.
- [ ] O CI falha diante de drift estrutural não aprovado.
