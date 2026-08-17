# 21 — Consolidar foreign keys e triggers

**What to build:** manter uma única regra determinística para cada relacionamento, timestamp, validação e efeito de estoque.

**Blocked by:** 15 — Inicializar banco vazio e detectar drift no CI; 17 — Dar ownership a fornecedores e escopar IDs externos; 20 — Contrair o modelo fiscal legado.

**Status:** ready-for-agent

- [ ] Ação de exclusão de cada relacionamento é explícita e não conflitante.
- [ ] Triggers duplicados são removidos somente após teste comportamental.
- [ ] Uma mutação produz cada efeito exatamente uma vez.
- [ ] Dados existentes satisfazem as constraints canônicas.
