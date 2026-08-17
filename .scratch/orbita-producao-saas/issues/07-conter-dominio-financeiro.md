# 07 — Conter o domínio financeiro

**What to build:** manter os fluxos financeiros funcionais sem permitir leitura ou mutação global enquanto o ownership definitivo ainda é saneado.

**Blocked by:** 03 — Criar o contexto confiável de ator e tenant; 04 — Criar o laboratório descartável do Supabase; 06 — Revogar grants e RPCs perigosos.

**Status:** ready-for-agent

- [ ] Policies permissivas deixam de permitir acesso global.
- [ ] Acesso direto do navegador falha quando o ownership não pode ser comprovado.
- [ ] Fluxos server-side preservados aplicam tenant verificado em todas as consultas e mutações.
- [ ] Testes cobrem leitura, criação, atualização e exclusão autorizadas e cross-tenant.
