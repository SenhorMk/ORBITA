# 23 — Comprovar integridade da baseline saneada

**What to build:** demonstrar que a baseline não possui ownership nulo, órfãos, referências cross-tenant ou duplicidades incompatíveis.

**Blocked by:** 16 — Classificar e quarentenar registros financeiros sem tenant; 17 — Dar ownership a fornecedores e escopar IDs externos; 20 — Contrair o modelo fiscal legado; 21 — Consolidar foreign keys e triggers; 22 — Adicionar índices orientados ao tenancy e às consultas.

**Status:** ready-for-agent

- [ ] Checks retornam zero ownership nulo fora da quarentena.
- [ ] Checks retornam zero órfão e zero mismatch cross-tenant.
- [ ] Constraints rejeitam duplicidades e relações inválidas.
- [ ] Bootstrap e staging produzem os mesmos resultados de integridade.
