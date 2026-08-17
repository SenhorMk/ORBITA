# 05 — Fechar rotas públicas e IDORs conhecidos

**What to build:** impedir que categorias, pedidos e demais recursos críticos sejam consultados ou alterados sem autenticação e autorização de tenant.

**Blocked by:** 03 — Criar o contexto confiável de ator e tenant; 04 — Criar o laboratório descartável do Supabase.

**Status:** done

- [x] Toda rota listada na auditoria autentica e autoriza a ação separadamente.
- [x] IDs pertencentes a outro tenant retornam negação sem revelar existência do recurso.
- [x] Operações válidas continuam funcionando para o tenant autorizado.
- [x] Cada defeito corrigido possui teste de regressão no seam público correspondente.

## Evidências de implementação

- `GET /api/categorias/sync` exige `app:access`; `POST` exige `tenant:manage`.
- Categorias são lidas e persistidas com o `VerifiedTenant`, usando o conflito composto `user_id, bling_id`.
- `GET`, `PUT` e `DELETE /api/bling/pedidos/[id]` provam a posse local tenant-scoped antes de acessar o Bling.
- Pedido inexistente e pedido de outro tenant retornam a mesma resposta `404`, sem revelar sua existência.
- Exclusão local exige simultaneamente `user_id` e `bling_id`; a exclusão global anterior foi removida.
- Handlers HTTP são testados por comportamento para 401, 403, cross-tenant 404 e operações válidas do proprietário.

## Verificação

- `npm test`: 13 arquivos e 50 testes aprovados.
- `npm run typecheck`: aprovado.
- `npm run build`: aprovado.
- `npm run lint:ratchet`: aprovado sem dívida nova.
- `npm run aislop`: aprovado sem dívida nova.
- `npm run secrets:check`: aprovado.
- `npm run test:db`: 7 testes pgTAP aprovados no laboratório local descartável.
- `git diff --check`: aprovado.

## Banco e operação

- Nenhuma migration foi necessária: o schema canônico já possui `categorias.user_id`, `pedidos.user_id` e unicidade tenant-scoped.
- Nenhuma escrita foi realizada no Supabase remoto.
- Rollback: reverter os handlers, serviços e adapter de repositório deste ticket; não há rollback de dados.
