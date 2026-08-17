# 40 — Adicionar auditoria, correlação e telemetria

**What to build:** permitir diagnóstico ponta a ponta de requests, jobs, webhooks e provedores sem registrar segredos ou payloads sensíveis.

**Blocked by:** 13 — Comprovar o gate de contenção P0; 24 — Criar organização, membership e organização ativa; 34 — Executar sincronizações como jobs duráveis.

**Status:** ready-for-agent

- [ ] Correlation ID atravessa os principais boundaries internos e externos.
- [ ] Erros esperados possuem tags e contexto seguro.
- [ ] Ações sensíveis geram eventos de auditoria imutáveis.
- [ ] Métricas e alertas distinguem falha de aplicação, banco, fila e provedor.
