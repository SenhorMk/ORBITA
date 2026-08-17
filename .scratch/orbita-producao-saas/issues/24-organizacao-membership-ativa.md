# 24 — Criar organização, membership e organização ativa

**What to build:** permitir que um proprietário crie uma organização e trabalhe em seus dados por membership, selecionando com segurança a organização ativa.

**Blocked by:** 03 — Criar o contexto confiável de ator e tenant; 15 — Inicializar banco vazio e detectar drift no CI; 23 — Comprovar integridade da baseline saneada.

**Status:** ready-for-agent

- [ ] A criação da organização também cria a membership de proprietário atomicamente.
- [ ] A organização ativa é selecionada pelo usuário e revalidada no servidor.
- [ ] Usuário externo não acessa a organização apenas conhecendo seu ID.
- [ ] RLS, aplicação e interface demonstram o primeiro fluxo completo por organização.
