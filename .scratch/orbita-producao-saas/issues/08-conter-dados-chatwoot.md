# 08 — Conter os dados Chatwoot

**What to build:** bloquear a exposição global de contatos, conversas e mensagens, preservando somente operações server-side que consigam demonstrar o tenant correto.

**Blocked by:** 03 — Criar o contexto confiável de ator e tenant; 04 — Criar o laboratório descartável do Supabase; 06 — Revogar grants e RPCs perigosos.

**Status:** ready-for-agent

- [ ] Usuários autenticados comuns não conseguem consultar ou alterar dados Chatwoot globais.
- [ ] Operações temporariamente server-side exigem escopo confiável.
- [ ] Respostas não vazam conteúdo ou existência de conversas de outro tenant.
- [ ] Testes registram o comportamento seguro até a migração definitiva de tenancy.
