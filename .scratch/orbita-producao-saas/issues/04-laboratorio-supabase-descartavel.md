# 04 — Criar o laboratório descartável do Supabase

**What to build:** permitir que políticas, grants, funções e fluxos persistentes sejam exercitados em banco descartável como usuários anônimo, autenticado e privilegiado, sem tocar em produção.

**Blocked by:** 02 — Restabelecer o gate mínimo de engenharia.

**Status:** ready-for-agent

- [ ] A suíte cria e destrói um ambiente isolado sem depender do projeto de produção.
- [ ] Fixtures incluem tenants A e B, owner, colaborador e usuário externo.
- [ ] O primeiro teste prova uma permissão válida e uma negação cross-tenant.
- [ ] O comando é reproduzível localmente e no CI.
