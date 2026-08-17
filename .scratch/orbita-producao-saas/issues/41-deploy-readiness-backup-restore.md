# 41 — Preparar deploy, readiness, backup e restore

**What to build:** tornar releases reversíveis e impedir tráfego para versões incapazes de operar com banco, jobs ou integrações.

**Blocked by:** 15 — Inicializar banco vazio e detectar drift no CI; 35 — Adicionar outbox, retries e saúde das integrações; 39 — Implementar suspensão, retenção e encerramento; 40 — Adicionar auditoria, correlação e telemetria.

**Status:** ready-for-agent

- [ ] Migrations e backfills executam como etapas separadas e observáveis do deploy.
- [ ] Readiness considera dependências indispensáveis sem expor dados sensíveis.
- [ ] Backup e restore são executados e cronometrados em ambiente seguro.
- [ ] Rollback de aplicação e rollback lógico de dados possuem runbook ensaiado.
