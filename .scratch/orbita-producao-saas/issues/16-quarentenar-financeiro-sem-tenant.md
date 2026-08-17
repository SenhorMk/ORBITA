# 16 — Classificar e quarentenar registros financeiros sem tenant

**What to build:** resolver registros financeiros sem proprietário por evidência confiável, mantendo itens ambíguos isolados e recuperáveis.

**Blocked by:** 07 — Conter o domínio financeiro; 14 — Reconstruir a baseline canônica do banco.

**Status:** ready-for-agent

- [ ] Cada registro sem tenant recebe uma classificação auditável.
- [ ] Nenhum ownership é inferido de entrada não confiável.
- [ ] Itens ambíguos ficam inacessíveis aos tenants e podem ser revisados.
- [ ] O backfill é idempotente, resumível e validado antes de impor obrigatoriedade.
