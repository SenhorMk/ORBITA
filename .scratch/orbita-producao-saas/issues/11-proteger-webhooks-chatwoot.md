# 11 — Autenticar e proteger webhooks Chatwoot

**What to build:** aceitar eventos Chatwoot somente quando sua autenticidade e vínculo com uma conexão conhecida forem comprovados, rejeitando replay antes dos efeitos.

**Blocked by:** 01 — Rotacionar e selar o ciclo de vida dos segredos; 03 — Criar o contexto confiável de ator e tenant.

**Status:** ready-for-agent

- [ ] Eventos inválidos falham antes de qualquer persistência ou chamada externa.
- [ ] A conta, inbox e tenant são resolvidos por configuração server-side confiável.
- [ ] Reenvio do mesmo evento não duplica efeitos.
- [ ] Logs de segurança não contêm assinatura, token ou conteúdo sensível bruto.
