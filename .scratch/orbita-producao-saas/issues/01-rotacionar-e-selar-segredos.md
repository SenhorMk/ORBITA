# 01 — Rotacionar e selar o ciclo de vida dos segredos

**What to build:** garantir que o ORBITA inicialize somente com credenciais válidas e não versionadas, com rotação documentada e detecção automática de novas exposições.

**Blocked by:** None — can start immediately.

**Status:** needs-owner — contenção concluída; rotação externa pendente

- [x] Todo segredo previamente versionado é identificado sem registrar seu valor em relatórios ou logs.
- [ ] Credenciais comprometidas são rotacionadas nos respectivos provedores e a aplicação funciona com os novos valores.
- [x] Arquivos reais de ambiente permanecem ignorados e somente exemplos sanitizados são versionados.
- [x] O CI falha quando uma credencial real ou padrão proibido é introduzido.
