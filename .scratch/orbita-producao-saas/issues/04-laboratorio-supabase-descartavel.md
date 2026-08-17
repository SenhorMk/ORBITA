# 04 — Criar o laboratório descartável do Supabase

**What to build:** permitir que políticas, grants, funções e fluxos persistentes sejam exercitados em banco descartável como usuários anônimo, autenticado e privilegiado, sem tocar em produção.

**Blocked by:** 02 — Restabelecer o gate mínimo de engenharia.

**Status:** done

- [x] A suíte cria e destrói um ambiente isolado sem depender do projeto de produção.
- [x] Fixtures incluem tenants A e B, owner, colaborador e usuário externo.
- [x] O primeiro teste prova uma permissão válida e uma negação cross-tenant.
- [x] O comando é reproduzível localmente e no CI.

## Implementation evidence

- `npm run test:db` inicia somente o Postgres local do projeto `orbita-database-lab`, força `db reset --local --no-seed`, executa pgTAP com `test db --local` e sempre chama `stop --no-backup` para o mesmo project ID.
- O runner remove `SUPABASE_ACCESS_TOKEN` e `SUPABASE_DB_PASSWORD` do ambiente e rejeita flags remotas (`--linked`, `--project-ref` e `--db-url`) antes de executar qualquer comando.
- A fixture transacional contém tenants A/B, owners A/B, colaborador do tenant A, usuário autenticado externo e documentos privados de ambos os tenants.
- O smoke test exercita os roles PostgreSQL `anon`, `authenticated` e `service_role`; nenhuma fixture ou objeto de teste permanece após o rollback e o teardown.
- O job `database-lab` do GitHub Actions executa o mesmo comando em Ubuntu/Node 22/Docker, sem secrets do Supabase.

## Verification

- `npm run test:db`: 1 arquivo pgTAP e 7 assertions verdes; ambiente iniciado, resetado e destruído com exit code 0.
- `npm test`: 11 arquivos e 42 testes verdes, incluindo allowlist de comandos locais e cleanup em falha.
- `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop` e `npm run build`: verdes.

## Security, database, and rollout

- Segurança: o laboratório não contém project ref hospedado, login, API key ou senha; comandos de banco exigem `--local` e o CI não recebe secrets.
- Banco: nenhuma migration, DDL ou DML remota. O SQL legado em `database/` permanece fora do bootstrap até a baseline canônica dos tickets 14 e 15.
- Rollout: mergear o job de CI e usar `supabase/tests/database/` como seam para os testes RLS/grants/functions dos próximos tickets.
- Rollback: reverter o commit remove configuração, runner e job; o teardown `--no-backup` já elimina os volumes locais do laboratório.
