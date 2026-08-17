# 03 — Criar o contexto confiável de ator e tenant

**What to build:** oferecer às operações do ORBITA um contexto server-side que derive o ator autenticado e o tenant autorizado, exigindo escopo explícito em acessos privilegiados.

**Blocked by:** 02 — Restabelecer o gate mínimo de engenharia.

**Status:** done

- [x] Identidade e tenant são derivados de sessão verificada, nunca aceitos somente do payload.
- [x] Ausência de sessão, membership ou capacidade resulta em negação tipada e segura.
- [x] Adapters com service role exigem um tenant previamente verificado.
- [x] Testes cobrem usuário autorizado, usuário externo e sessão ausente.

## Implementation evidence

- `resolveActorContext` valida bearer session, metadata server-side e capacidade antes de produzir `ActorContext` e `VerifiedTenant`.
- O owner mantém o ownership P0 atual; colaborador só recebe tenant com atribuição server-side explícita. Organizations e memberships persistidas continuam no ticket 24.
- Repositories, sync, integração SAC→ERP e cliente Bling exigem `VerifiedTenant`; não existe cliente Bling privilegiado sem tenant.
- Webhook Bling só produz contexto após HMAC do raw body com segredo descriptografado de mapping server-side.
- `POST /api/config` demonstra a negação tipada no boundary HTTP: sessão inválida retorna 401 e membership/capacidade insuficiente retorna 403.

## Verification

- `npm test`: 39 testes verdes, incluindo owner, colaborador, usuário externo, sessão ausente, capacidade negada e assinatura server-side.
- `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop` e `npm run build`: verdes.
- Revisão por pares Standards + Spec: sem bloqueadores após a segunda rodada.

## Security, database, and rollout

- Segurança: remove o fallback que promovia qualquer usuário autenticado a colaborador e torna o tenant um requisito opaco nos adapters privilegiados.
- Banco: nenhuma migration ou escrita remota; o ticket preserva temporariamente o ownership `user_id` já existente.
- Rollout: publicar aplicação e observar negações 401/403. Colaboradores legados sem `app_metadata.tenant_id` falham fechados até receberem atribuição confiável ou migrarem no ticket 24.
- Rollback: reverter o commit da aplicação; não há rollback de banco.
