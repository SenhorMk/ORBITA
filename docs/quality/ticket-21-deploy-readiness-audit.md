# Auditoria — Ticket 21 (deploy readiness, health checks, backup/restore)

## Health checks — estado antes desta branch

| Rota | Antes | Veredito |
|---|---|---|
| `GET /api/liveness` | Sempre `200 {status:'alive'}`, sem I/O. | Correto como liveness — sem alteração de comportamento. |
| `GET /api/readiness` | Consultava `supabaseServer` diretamente; teste usava `vi.mock('@/lib/supabaseServer', ...)` (proibido pelo contrato de execução dos tickets 07-25); sem timeout explícito; sem separação de dependência/adapter. | Refeito com DI (`evaluateDependencies`), timeout curto (2s), teste sem `vi.mock`. |
| `POST /api/startup` | **Não é um probe de infraestrutura.** É um endpoint de negócio que dispara a sincronização inicial com o Bling, consumido por `src/components/StartupLoader.tsx`. | Mantido intacto (repurposá-lo quebraria a UI). Um probe de startup real de infraestrutura foi criado em `GET /api/health/startup`, documentado como distinto. |

Não havia nenhum probe de startup (no sentido "prova inicialização/migrations/config") antes desta branch.

## Correções aplicadas

- `src/lib/health/dependencyCheck.ts` (novo): avaliador de dependências com DI, timeout por
  dependência, falha fechada (`ok:false`, exceção ou timeout ⇒ `error`/`timeout`), nunca repassa o
  objeto de erro bruto ao chamador (só via `onError` com uma tag segura).
- `src/lib/health/databaseDependency.ts` (novo): adapter de produção para o check de conectividade
  com o banco (`organizacoes`), usado apenas em runtime real (nunca importado por testes unitários).
- `src/lib/health/schemaDependency.ts` (novo): adapter de produção do probe de startup — confirma
  que as tabelas baseline (`organizacoes`, `membros_organizacao`) existem, provando que as migrations
  já rodaram como etapa anterior observável. **Bug corrigido:** um rascunho inicial usava o nome de
  tabela `membros`, que não existe (a tabela real é `membros_organizacao` — ver
  `database/20_organizacao_membership_ativa.sql`); corrigido antes de qualquer merge.
- `src/lib/health/startupCheck.ts` (novo): `evaluateStartupConfig` (puro, sem I/O) valida config via
  `src/lib/runtime-config.ts` (reaproveitado, não recriado); `evaluateStartup` só tenta o check de
  schema se a config for válida — nunca tenta conectar com credencial placeholder.
- `src/app/api/readiness/route.ts`: reescrito para expor `readinessResponse(req, dependencies)`
  testável por injeção, com `GET` fazendo o import tardio (`await import(...)`) do adapter de
  produção — isso evita que `supabaseServer` (que lança na importação se a config for inválida) seja
  construído ao simplesmente importar o módulo de rota em teste, e converte esse mesmo lançamento em
  um `503` correto em produção, em vez de um crash do processo.
- `src/app/api/health/startup/route.ts` (novo): mesmo padrão de import tardio.
- Resposta de ambas as rotas nunca inclui URL, key, stack trace ou payload de provider — coberto por
  teste dedicado que injeta um erro com uma "connection string" fake e verifica que o texto não
  aparece no corpo da resposta.
- `src/app/api/readiness/readiness.test.ts` e o novo `src/app/api/health/startup/startup.test.ts`
  reescritos sem `vi.mock`, usando fakes escritos à mão (padrão já usado em
  `src/services/privacy/adapters/dbAdapter.test.ts`), injetando ausência (`throw ECONNREFUSED`),
  placeholder (`ok:false`/config inválida), timeout (promise que só resolve no abort), 401/5xx
  (`ok:false`/`throw`).
- `src/app/api/liveness/liveness.test.ts` (novo): teste próprio, extraído do arquivo combinado
  anterior.

## Backup/restore — estado antes desta branch

`scripts/test-backup-restore.mjs` (`npm run test:backup`) era **simulação em memória**:
`simulateLogicalBackup`/`simulateLogicalRestore` somavam contadores de um objeto mock e mediam
`Date.now() - startTime + 5ms` fixo — nunca tocava em Postgres real. Isso é exatamente o que o
ticket 21 proíbe ("Não usar simulação em memória como backup").

`scripts/database-lab.mjs` + `scripts/local-database-client.mjs` já forneciam um laboratório
Postgres local real via Supabase CLI (Docker, porta 54322), com aplicação determinística das 55
migrations canônicas — reaproveitado como origem do backup real.

## Correção aplicada

`scripts/test-backup-restore.mjs` foi reescrito para um ensaio real:

1. Sobe o laboratório Supabase local (`supabase db start`, Docker).
2. Aplica as 55 migrations canônicas via `applyCanonicalMigrations`.
3. Semeia dados sintéticos multi-tenant (2 organizações, 2 usuários `auth.users`, memberships,
   clientes vinculados a cada tenant).
4. `pg_dump` real (formato custom) do schema `public` + dump de dados de `auth.users`, executado via
   `docker run` do mesmo tag de imagem usado pelo laboratório (`public.ecr.aws/supabase/postgres:17.6.1.158`),
   nunca via string de shell (argv array).
5. Sobe uma **segunda** instância Postgres, dedicada e vazia (`orbita-backup-restore-lab`, porta
   55432), aguarda prontidão real (via `SELECT 1`, não apenas `pg_isready`, porque a imagem Supabase
   reinicia o processo Postgres uma segunda vez durante seu próprio bootstrap).
6. `pg_restore` real na segunda instância.
7. Valida: contagem de tabelas, contagem/checksum por linha, tipos e contagens de constraint,
   contagem de policies RLS e de tabelas com RLS habilitado, contagem de funções, contagem de
   índices — tudo via `captureSchemaFingerprint`/`diffFingerprints`, comparando origem × destino.
8. Smoke multi-tenant: cada organização sintética sobrevive, cada tenant só vê seus próprios
   `clientes`, nenhum vazamento cross-tenant.
9. Smoke de jornada crítica: `criar_organizacao_atomica` (função central de criação de organização)
   continua presente após o restore.
10. Mede tempo real de dump/restore e bytes reais do dump; nunca estima.
11. Cleanup incondicional (`finally`): apaga os arquivos de dump, remove o container de restore,
    derruba o laboratório de origem — mesmo em falha.

Execução real registrada em `.scratch/orbita-mvp-producao-v2/evidence/21-backup-restore-run.json` e
resumida em `.scratch/orbita-mvp-producao-v2/evidence/21-final-evidence.md`.

### Limitações conhecidas e documentadas (não simuladas, mas com escopo definido)

- O fingerprint de validação cobre apenas o schema `public` (tudo criado pelas migrations da
  ORBITA). `auth`/`storage`/outros schemas do Supabase são provisionados de forma idêntica pela
  própria imagem em ambas as instâncias — só os dados de `auth.users` (não o schema) são
  copiados/validados via smoke, não via fingerprint completo.
- `pg_restore` retorna exit code não-zero mesmo em uma restauração bem-sucedida por causa de um erro
  conhecido e inofensivo (`CREATE SCHEMA public` — já existe no bootstrap padrão da imagem); por isso
  o critério de sucesso real é o fingerprint pós-restore + smoke, não o exit code do `pg_restore`
  isoladamente. Documentado no código (`evidence.restore.publicSchemaExitOk`) e neste arquivo.
- O smoke multi-tenant conecta como `postgres` (superusuário, bypassa RLS) — prova integridade do
  predicado de tenant nos dados, não o comportamento de RLS como papel `authenticated` com JWT real.
  RLS em si já é coberto por pgTAP em `supabase/tests/database/*.test.sql`, fora do escopo deste
  ensaio de backup/restore.
