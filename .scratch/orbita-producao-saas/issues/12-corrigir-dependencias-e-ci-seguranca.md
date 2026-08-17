# 12 — Corrigir dependências vulneráveis e automatizar verificações

**What to build:** remover ou mitigar vulnerabilidades altas conhecidas e impedir que novas dependências inseguras ou credenciais expostas cheguem à branch.

**Blocked by:** 02 — Restabelecer o gate mínimo de engenharia.

**Status:** ready-for-agent

- [ ] Vulnerabilidades altas de runtime são corrigidas ou possuem exceção documentada com prazo.
- [ ] O CI executa auditoria de dependências e secret scan.
- [ ] Falhas relevantes bloqueiam merge sem imprimir segredos.
- [ ] Atualizações preservam typecheck, testes e build.
