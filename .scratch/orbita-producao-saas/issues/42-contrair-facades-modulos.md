# 42 — Contrair facades e impor limites do monólito modular

**What to build:** concluir as migrações incrementais expondo APIs coesas para tenancy, comercial, financeiro e integrações, sem imports cruzados de internals.

**Blocked by:** 36 — Contrair o tenancy legado por usuário; 40 — Adicionar auditoria, correlação e telemetria.

**Status:** ready-for-agent

- [ ] Cada capacidade possui uma superfície pública pequena e documentada.
- [ ] Domínio não depende de Next.js, Supabase, React ou SDKs de provedores.
- [ ] Facades de compatibilidade sem callers são removidas.
- [ ] Verificação automática detecta imports entre internals de módulos.
