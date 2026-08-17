# 35 — Adicionar outbox, retries e saúde das integrações

**What to build:** reenviar efeitos externos com segurança e mostrar ao usuário quando cada integração está saudável, degradada ou desconectada.

**Blocked by:** 34 — Executar sincronizações como jobs duráveis.

**Status:** ready-for-agent

- [ ] Efeitos que cruzam transações são persistidos antes do envio.
- [ ] Retry respeita idempotência, limite, backoff e classificação do erro.
- [ ] Falhas definitivas ficam disponíveis para intervenção sem loop infinito.
- [ ] A interface apresenta estado e último diagnóstico seguro por conexão.
