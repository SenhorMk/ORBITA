# 18 — Expandir o modelo fiscal canônico

**What to build:** introduzir uma representação fiscal canônica compatível com dados e callers existentes, sem remover o legado prematuramente.

**Blocked by:** 15 — Inicializar banco vazio e detectar drift no CI.

**Status:** ready-for-agent

- [ ] O modelo canônico preserva ownership e integridade do pedido.
- [ ] Escritas novas podem alimentar a estrutura canônica sem quebrar leituras legadas.
- [ ] Constraints impedem duplicidades inválidas dentro do tenant.
- [ ] Testes provam compatibilidade durante a fase expandida.
