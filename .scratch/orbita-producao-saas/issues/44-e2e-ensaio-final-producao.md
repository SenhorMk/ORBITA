# 44 — Executar jornada E2E e ensaio final de produção

**What to build:** comprovar em staging que o ORBITA pode operar, falhar e se recuperar como SaaS antes de liberar tráfego real.

**Blocked by:** 38 — Integrar Stripe para assinatura e cobrança; 41 — Preparar deploy, readiness, backup e restore; 43 — Eliminar dívida residual de lint, tipos e AI slop.

**Status:** ready-for-agent

- [ ] E2E cobre login, organização, convite, pedido crítico, Bling, Chatwoot, Stripe e logout.
- [ ] Jornadas críticas passam com teclado, foco visível e feedback acessível.
- [ ] Rollback e restore são executados com evidência.
- [ ] Pentest autorizado e gates completos não deixam bloqueador crítico ou alto sem decisão formal.
