# 03 — Criar o contexto confiável de ator e tenant

**What to build:** oferecer às operações do ORBITA um contexto server-side que derive o ator autenticado e o tenant autorizado, exigindo escopo explícito em acessos privilegiados.

**Blocked by:** 02 — Restabelecer o gate mínimo de engenharia.

**Status:** ready-for-agent

- [ ] Identidade e tenant são derivados de sessão verificada, nunca aceitos somente do payload.
- [ ] Ausência de sessão, membership ou capacidade resulta em negação tipada e segura.
- [ ] Adapters com service role exigem um tenant previamente verificado.
- [ ] Testes cobrem usuário autorizado, usuário externo e sessão ausente.
