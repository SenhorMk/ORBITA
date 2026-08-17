# 09 — Endurecer cadastro, sessão e OAuth

**What to build:** entregar cadastro e conexão OAuth resistentes a elevação indevida, CSRF, replay e vazamento de tokens.

**Blocked by:** 01 — Rotacionar e selar o ciclo de vida dos segredos; 03 — Criar o contexto confiável de ator e tenant.

**Status:** ready-for-agent

- [ ] Cadastro público não cria nem confirma proprietários por service role sem fluxo confiável.
- [ ] Estado OAuth é de uso único, vinculado à sessão e possui expiração.
- [ ] Tokens não aparecem em URL, resposta pública, log ou cookie com atributos inadequados.
- [ ] Testes cobrem callback válido, estado ausente, inválido, expirado e repetido.
