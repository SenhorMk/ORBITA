# 17 — Dar ownership a fornecedores e escopar IDs externos

**What to build:** permitir que diferentes tenants armazenem fornecedores e identificadores Bling iguais sem colisão ou exposição de existência.

**Blocked by:** 15 — Inicializar banco vazio e detectar drift no CI; 16 — Classificar e quarentenar registros financeiros sem tenant.

**Status:** ready-for-agent

- [ ] Fornecedor possui ownership obrigatório e verificável.
- [ ] Relações financeiras impedem referências cross-tenant.
- [ ] Identificadores externos são únicos no escopo correto.
- [ ] Fluxos existentes permanecem compatíveis durante expand–backfill–contract.
