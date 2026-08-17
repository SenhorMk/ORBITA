# 34 — Executar sincronizações como jobs duráveis

**What to build:** fazer sincronizações sobreviverem a término de request ou processo, avançando checkpoints somente após confirmação completa do lote.

**Blocked by:** 32 — Persistir inbox idempotente para Bling; 33 — Persistir inbox idempotente para Chatwoot.

**Status:** ready-for-agent

- [ ] Disparo HTTP apenas agenda trabalho e retorna estado observável.
- [ ] Lease impede execução concorrente incompatível e expira com segurança.
- [ ] Falha parcial não confirma checkpoint nem perde itens.
- [ ] Retry após crash retoma o trabalho sem duplicar efeitos.
