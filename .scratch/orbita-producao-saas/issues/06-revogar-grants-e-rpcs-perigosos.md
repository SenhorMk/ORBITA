# 06 — Revogar grants e RPCs perigosos

**What to build:** limitar roles de navegador e funções mutáveis ao conjunto mínimo de operações necessário, derivando o escopo de identidades confiáveis.

**Blocked by:** 04 — Criar o laboratório descartável do Supabase.

**Status:** done

- [x] `anon` e `authenticated` não possuem privilégios destrutivos ou administrativos desnecessários.
- [x] Funções mutáveis e privilegiadas não são executáveis por `PUBLIC` ou `anon`.
- [x] Funções privilegiadas usam resolução de objetos endurecida e escopo validado.
- [x] Testes provam negação anônima, negação cross-tenant e operação server-side válida.

## Evidências de implementação

- A migration `09_harden_grants_and_rpcs.sql` fecha grants existentes e defaults globais/do schema para `PUBLIC`, `anon` e `authenticated`; o navegador autenticado conserva somente `SELECT` nas seis projeções usadas diretamente pela UI.
- Toda função em `public` perde execução implícita. Somente sete RPCs usados pelo servidor recebem `EXECUTE` explícito para `service_role`.
- `decrement_estoque` e os locks de NF-e exigem `p_user_id`; a aplicação envia exclusivamente o tenant derivado da sessão verificada.
- Os RPCs privilegiados são `SECURITY INVOKER`, usam `search_path = ''` e qualificam objetos em `public`/`pg_catalog`.
- A assinatura antiga e sem tenant de `decrement_estoque`, os locks antigos de NF-e e o alias `unlock_sync` são removidos.
- O laboratório copia a migration canônica para um include efêmero, executa o SQL real no pgTAP e remove o artefato durante o teardown.
- As skills oficiais `supabase/agent-skills` foram instaladas no repositório e registradas em `AGENTS.md`; `database-sentinel` ficou explicitamente desativada conforme decisão do usuário.

## Verificação

- `npm run test:db`: 29 testes pgTAP aprovados, incluindo negação real para `anon`/`authenticated`, negação cross-tenant e mutação válida pelo servidor.
- `npm test`: 13 arquivos e 51 testes aprovados.
- `npm run typecheck`: aprovado.
- `npm run build`: aprovado.
- `npm run lint:ratchet`: aprovado sem dívida nova.
- `npm run aislop`: aprovado sem dívida nova.
- `npm run secrets:check`: aprovado.
- `git diff --check`: aprovado.

## Banco, rollout e rollback

- A inspeção do Supabase remoto foi somente leitura; nenhuma DDL, DML ou migration foi aplicada ao projeto compartilhado.
- Rollout: aplicar a migration 09 e publicar a aplicação no mesmo release, pois as assinaturas tenant-scoped substituem contratos antigos. Validar os grants e os sete RPCs antes de liberar tráfego.
- O papel de migration endurece os defaults pertencentes a `postgres`. Defaults do papel interno `supabase_admin` são tentados defensivamente, mas o Supabase pode impedir sua alteração; todos os objetos existentes continuam sendo revogados explicitamente.
- Rollback preferencial: corrigir para frente. Em emergência, reverter aplicação e migration de forma coordenada; restaurar assinaturas antigas apenas para `service_role`, nunca para roles de navegador, e removê-las novamente após estabilização.
