# 31 — Migrar a conexão Chatwoot para organização

**What to build:** persistir contatos, conversas e mensagens por conexão e organização, eliminando colisões globais.

**Blocked by:** 08 — Conter os dados Chatwoot; 11 — Autenticar e proteger webhooks Chatwoot; 29 — Criar conexões e credenciais privadas.

**Status:** ready-for-agent

- [ ] Configuração Chatwoot pertence a uma organização.
- [ ] Conta, inbox e IDs externos são scoped pela conexão.
- [ ] Dados persistidos carregam organização por toda a hierarquia.
- [ ] Contract tests cobrem respostas válidas, inválidas, indisponibilidade e retry elegível.
