# Plano de evolução do ORBITA para SaaS de produção

## Baseline congelada

- Repositório: `SenhorMk/Orbita`
- Branch auditada: `feature/correcoes-arquiteturais`
- Commit auditado: `5e0be2ac845468dbb90e6f3d87442378ecc4a884`
- Data da auditoria: 2026-08-17
- Estado: deploy bloqueado até conclusão do P0

Este documento preserva o resultado da revisão estática, das três revisões independentes e dos feedback loops locais. A auditoria do banco remoto ainda deve ser executada e reconciliada com este plano.

## Evidências da baseline

- O build gera os bundles, mas falha no typecheck em `src/app/api/financeiro/route.ts`.
- ESLint: 231 erros.
- AI slop: score 10/100, 4 erros e 339 avisos.
- `npm audit --omit=dev`: três vulnerabilidades altas.
- Não existe runner de testes JavaScript configurado.
- `database/schema_master.sql` não inicializa um banco vazio e contém definição duplicada de `id` em `pedidos`.
- O README referencia migrations inexistentes.
- A branch não possui ancestral comum com `origin/main`.
- `.env` está rastreado e o histórico contém ciclos de inclusão e remoção de segredos.

## Riscos bloqueadores

1. Rotação e remoção de todos os segredos versionados.
2. Rota de categorias sem autenticação ou escopo de tenant.
3. DELETE de pedido sem predicado de tenant.
4. Financeiro com RLS permissiva, `user_id` anulável e unicidade global.
5. Chatwoot global, com operações e IDs externos sem isolamento por tenant.
6. Cadastro público usando service-role para criar e auto-confirmar proprietários.
7. Migrations contraditórias e bootstrap de banco não reproduzível.
8. RPCs e políticas RLS dependentes da ordem manual dos scripts.
9. OAuth com token em URL, state fraco e logs sensíveis.
10. Webhooks sem replay protection e idempotência durável.
11. Sync que converte erros em listas vazias e avança checkpoints após falha parcial.
12. Ausência de observabilidade, gates de release e testes multitenant.

## Arquitetura-alvo

O ORBITA será mantido como monólito modular incremental, com:

- `organizations` como boundary de tenancy;
- `memberships`, convites e autorização por capacidade;
- `organization_id` obrigatório em todas as entidades do tenant;
- RLS fail-closed, constraints e FKs compostas;
- service-role restrita a infraestrutura server-side;
- módulos de domínio com APIs públicas pequenas;
- adapters Bling e Chatwoot instanciados por organização;
- validação runtime em todas as fronteiras;
- timeouts, erros tipados e retries apenas para operações seguras;
- inbox/outbox, idempotency keys e checkpoints duráveis;
- jobs fora do ciclo de requisição HTTP;
- configuração central validada;
- logs estruturados com redaction e correlation ID;
- migrations forward-only e deploy reproduzível.

## Plano de execução

### P0 — contenção e segurança

- Congelar deploy.
- Rotacionar Supabase, Bling, Chatwoot e chave de criptografia.
- Remover `.env` de todo o histórico e ativar secret scanning.
- Corrigir as rotas públicas e os IDORs conhecidos.
- Desabilitar o cadastro administrativo público.
- Atualizar dependências vulneráveis.
- Criar uma cadeia canônica de migrations que inicialize banco vazio.
- Corrigir RLS, RPCs, constraints e uniques do financeiro e Chatwoot.
- Zerar erros de TypeScript e obter build verde.

Gate: nenhum segredo rastreado; migrations executam em banco vazio; testes tenant A/B provam isolamento; build verde.

### P1 — fundação SaaS

- Criar organizações, memberships, convites e capacidades.
- Migrar `user_id` para `organization_id` com expand/backfill/contract.
- Centralizar autenticação, autorização e configuração.
- Implementar onboarding, confirmação de e-mail e recuperação de conta.
- Definir planos, assinatura, limites e ciclo de vida da organização.

Gate: membros compartilham dados dentro da organização e usuários externos recebem negação consistente.

### P2 — integrações confiáveis

- Extrair módulos Bling e Chatwoot.
- Persistir configuração por organização.
- Aplicar schemas runtime às respostas e webhooks.
- Implementar timeout, backoff com jitter e erros tipados.
- Criar inbox/outbox, replay protection e idempotência.
- Executar sync em worker ou fila durável.
- Avançar checkpoint somente após confirmação completa do lote.

Gate: replays e falhas parciais não duplicam nem perdem dados.

### P3 — produção e operação

- Logger estruturado, redaction, request ID e audit log.
- Métricas, tracing, alertas e SLOs.
- Health e readiness reais.
- CI/CD com preview e staging.
- Migration job, backup, restore e rollback ensaiados.
- Build sem dependência externa de fontes.

Gate: deploy automatizado em staging, smoke tests verdes e rollback comprovado.

### P4 — qualidade e redução de IA slop

- Decompor `page.tsx`, `bling.ts` e componentes grandes.
- Remover fallbacks silenciosos e scripts de correção descartáveis.
- Eliminar `any` nas fronteiras.
- Zerar lint e adicionar testes de regressão.
- Substituir o E2E legado por Playwright.
- Registrar ADRs, modelo de domínio e runbooks.

## Estratégia de testes

- Unitários para domínio e autorização.
- Integração com PostgreSQL/Supabase descartável.
- Testes negativos com tenants A e B para cada CRUD e RPC.
- Contract tests para Bling e Chatwoot.
- Casos de replay, timeout, retry, concorrência e idempotência.
- Playwright para login, organização, convite, integração e operação crítica.
- Bootstrap do banco vazio em CI.
- Gates: secret scan, typecheck, lint, testes, build, audit e AI slop.

## Auditoria do banco remoto concluída

A auditoria MCP somente leitura foi concluída em 2026-08-17. O relatório bruto está em `docs/SUPABASE_REMOTE_AUDIT_RAW.md` e a especificação reconciliada está em `docs/SPEC_SINCRONIZACAO_APP_BANCO.md`.

Resultado: 3 CRITICAL, 4 HIGH, 6 MEDIUM e 3 LOW. O deploy permanece bloqueado. Nenhuma alteração foi aplicada ao Supabase.

Principais confirmações:

1. Financeiro e fornecedores possuem RLS permissiva.
2. Chatwoot não possui ownership de tenant no banco real.
3. Funções/RPCs privilegiadas têm grants e validação de tenant inadequados.
4. Roles de navegador possuem privilégios excessivos.
5. Há linhas financeiras sem tenant, objetos legados e constraints/triggers duplicados.
6. O banco possui schema substancial, mas o ledger MCP de migrations está vazio.

## Fora de escopo inicial

- Microsserviços e Kubernetes.
- Event sourcing completo.
- Aplicativo mobile.
- Novos provedores antes de estabilizar Bling e Chatwoot.
- Otimizações de escala sem métricas reais.
