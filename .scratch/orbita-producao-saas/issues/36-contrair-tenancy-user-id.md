# 36 — Contrair o tenancy legado por usuário

**What to build:** remover a dependência de `user_id` como boundary de tenant depois que todos os domínios e integrações operarem por organização.

**Blocked by:** 27 — Migrar clientes, pedidos, estoque e fiscal; 28 — Migrar financeiro para organização; 30 — Migrar a conexão Bling para organização; 31 — Migrar a conexão Chatwoot para organização; 35 — Adicionar outbox, retries e saúde das integrações.

**Status:** ready-for-agent

- [ ] Busca de callers comprova que nenhum fluxo depende do ownership pessoal legado.
- [ ] Policies, constraints e índices canônicos usam organização e membership.
- [ ] Colunas ou facades legadas são removidas por contract migration segura.
- [ ] Owner, colaborador e usuário externo mantêm o comportamento esperado após a contração.
