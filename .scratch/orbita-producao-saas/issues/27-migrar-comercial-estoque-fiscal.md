# 27 — Migrar clientes, pedidos, estoque e fiscal

**What to build:** completar um fluxo comercial por organização, do cliente ao pedido, estoque e documento fiscal, sem referências cross-tenant.

**Blocked by:** 20 — Contrair o modelo fiscal legado; 21 — Consolidar foreign keys e triggers; 26 — Migrar catálogo para organização.

**Status:** ready-for-agent

- [ ] Clientes, pedidos, itens, estoque e fiscal carregam organização consistente.
- [ ] Constraints impedem relações entre organizações diferentes.
- [ ] Criação, consulta, atualização e exclusão respeitam capacidades.
- [ ] O fluxo completo funciona para membros autorizados e nega usuário externo.
