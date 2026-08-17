# 22 — Adicionar índices orientados ao tenancy e às consultas

**What to build:** manter consultas tenant-aware, foreign keys e políticas RLS eficientes conforme o volume cresce.

**Blocked by:** 21 — Consolidar foreign keys e triggers.

**Status:** ready-for-agent

- [ ] Foreign keys relevantes possuem suporte de índice adequado.
- [ ] Consultas críticas utilizam índices alinhados ao tenant e à ordenação.
- [ ] Índices redundantes são evitados ou removidos com evidência.
- [ ] Planos de consulta representativos não apresentam regressão material.
