# 33 — Persistir inbox idempotente para Chatwoot

**What to build:** registrar eventos Chatwoot antes dos efeitos e permitir replay seguro sem duplicar contatos, conversas ou mensagens.

**Blocked by:** 31 — Migrar a conexão Chatwoot para organização.

**Status:** ready-for-agent

- [ ] Cada evento possui chave idempotente no escopo da conexão.
- [ ] Duplicatas retornam o resultado seguro sem repetir efeitos.
- [ ] Falhas preservam evento e diagnóstico redigido para reprocessamento.
- [ ] Testes cobrem primeira entrega, duplicata, falha parcial e replay.
