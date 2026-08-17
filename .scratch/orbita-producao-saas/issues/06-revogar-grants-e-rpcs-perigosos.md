# 06 — Revogar grants e RPCs perigosos

**What to build:** limitar roles de navegador e funções mutáveis ao conjunto mínimo de operações necessário, derivando o escopo de identidades confiáveis.

**Blocked by:** 04 — Criar o laboratório descartável do Supabase.

**Status:** ready-for-agent

- [ ] `anon` e `authenticated` não possuem privilégios destrutivos ou administrativos desnecessários.
- [ ] Funções mutáveis e privilegiadas não são executáveis por `PUBLIC` ou `anon`.
- [ ] Funções privilegiadas usam resolução de objetos endurecida e escopo validado.
- [ ] Testes provam negação anônima, negação cross-tenant e operação server-side válida.
