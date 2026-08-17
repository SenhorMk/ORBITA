# 13 — Comprovar o gate de contenção P0

**What to build:** produzir evidência reproduzível de que os bloqueadores críticos de aplicação e banco foram contidos sem quebrar os fluxos essenciais.

**Blocked by:** 05 — Fechar rotas públicas e IDORs conhecidos; 06 — Revogar grants e RPCs perigosos; 07 — Conter o domínio financeiro; 08 — Conter os dados Chatwoot; 09 — Endurecer cadastro, sessão e OAuth; 10 — Autenticar e proteger webhooks Bling; 11 — Autenticar e proteger webhooks Chatwoot; 12 — Corrigir dependências vulneráveis e automatizar verificações.

**Status:** ready-for-agent

- [ ] A auditoria de banco não reporta achado crítico remanescente.
- [ ] Testes de rotas e RLS provam negações anônimas e cross-tenant.
- [ ] Fluxos essenciais aprovados continuam funcionais.
- [ ] O relatório de evidências não contém dados sensíveis.
