# 30 — Migrar a conexão Bling para organização

**What to build:** executar OAuth, renovação de token, locks e chamadas Bling usando uma conexão pertencente à organização autorizada.

**Blocked by:** 09 — Endurecer cadastro, sessão e OAuth; 10 — Autenticar e proteger webhooks Bling; 29 — Criar conexões e credenciais privadas.

**Status:** ready-for-agent

- [ ] OAuth associa a conexão somente à organização autorizada.
- [ ] Tokens são renovados e persistidos sem exposição ao navegador.
- [ ] Locks e IDs externos são scoped pela conexão correta.
- [ ] Contract tests cobrem sucesso, expiração, erro, timeout e rate limit.
