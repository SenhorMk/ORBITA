# 10 — Autenticar e proteger webhooks Bling

**What to build:** aceitar eventos Bling somente quando sua autenticidade e vínculo com uma conexão conhecida forem comprovados, rejeitando replay antes dos efeitos.

**Blocked by:** 01 — Rotacionar e selar o ciclo de vida dos segredos; 03 — Criar o contexto confiável de ator e tenant.

**Status:** ready-for-agent

- [ ] Eventos inválidos falham antes de qualquer persistência ou chamada externa.
- [ ] A conexão e o tenant não são derivados apenas do corpo recebido.
- [ ] Reenvio do mesmo evento não duplica efeitos.
- [ ] Logs de segurança não contêm assinatura, token ou payload sensível bruto.
