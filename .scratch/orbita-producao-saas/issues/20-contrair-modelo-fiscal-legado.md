# 20 — Contrair o modelo fiscal legado

**What to build:** remover a representação fiscal duplicada somente depois de provar que seus dados e dependentes foram migrados.

**Blocked by:** 19 — Migrar dados e callers fiscais.

**Status:** ready-for-agent

- [ ] Nenhum caller ou dependente utiliza o modelo legado.
- [ ] Dados históricos necessários permanecem disponíveis no modelo canônico.
- [ ] A migration de contração possui verificação prévia e rollback lógico.
- [ ] Bootstrap, integração e build continuam verdes após a remoção.
