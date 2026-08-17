# 14 — Reconstruir a baseline canônica do banco

**What to build:** tornar o schema desejado rastreável no Git, classificando cada objeto remoto como canônico, legado ou drift e preservando a história futura.

**Blocked by:** 13 — Comprovar o gate de contenção P0.

**Status:** ready-for-agent

- [ ] O inventário remoto sanitizado é reconciliado com todas as migrations locais.
- [ ] Cada objeto possui origem e destino documentados.
- [ ] A baseline não reaplica DDL perigoso em ambientes existentes.
- [ ] Mudanças futuras seguem migrations forward-only ordenadas.
