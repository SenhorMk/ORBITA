# 32 — Persistir inbox idempotente para Bling

**What to build:** registrar eventos Bling antes dos efeitos e permitir replay seguro sem duplicar estado de negócio.

**Blocked by:** 30 — Migrar a conexão Bling para organização.

**Status:** ready-for-agent

- [ ] Cada evento possui chave idempotente no escopo da conexão.
- [ ] Duplicatas retornam o resultado seguro sem repetir efeitos.
- [ ] Falhas preservam evento e diagnóstico redigido para reprocessamento.
- [ ] Testes cobrem primeira entrega, duplicata, falha parcial e replay.
