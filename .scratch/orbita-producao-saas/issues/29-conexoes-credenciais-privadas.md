# 29 — Criar conexões e credenciais privadas

**What to build:** permitir que cada organização configure integrações próprias sem expor tokens ou segredos pela Data API.

**Blocked by:** 01 — Rotacionar e selar o ciclo de vida dos segredos; 15 — Inicializar banco vazio e detectar drift no CI; 24 — Criar organização, membership e organização ativa.

**Status:** ready-for-agent

- [ ] Conexões pertencem a uma organização e possuem estado explícito.
- [ ] Credenciais ficam em armazenamento privado e criptografado com chave versionada.
- [ ] Somente adapters server-side conseguem obter valores brutos.
- [ ] Logs, erros, respostas e testes mantêm os valores redigidos.
