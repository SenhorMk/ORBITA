# 05 — Fechar rotas públicas e IDORs conhecidos

**What to build:** impedir que categorias, pedidos e demais recursos críticos sejam consultados ou alterados sem autenticação e autorização de tenant.

**Blocked by:** 03 — Criar o contexto confiável de ator e tenant; 04 — Criar o laboratório descartável do Supabase.

**Status:** ready-for-agent

- [ ] Toda rota listada na auditoria autentica e autoriza a ação separadamente.
- [ ] IDs pertencentes a outro tenant retornam negação sem revelar existência do recurso.
- [ ] Operações válidas continuam funcionando para o tenant autorizado.
- [ ] Cada defeito corrigido possui teste de regressão no seam público correspondente.
