# Especificação cruzada — ORBITA SaaS e Supabase

## Estado da decisão

- Branch de aplicação auditada: `feature/correcoes-arquiteturais`
- Commit-base da aplicação: `5e0be2ac845468dbb90e6f3d87442378ecc4a884`
- Banco auditado: projeto Supabase ORBITA, PostgreSQL 17.6
- Data da auditoria cruzada: 2026-08-17
- Modo da auditoria remota: MCP project-scoped, OAuth, `read_only=true`
- Estado de release: bloqueado até a conclusão do P0
- Resultado Database Sentinel: 3 CRITICAL, 4 HIGH, 6 MEDIUM e 3 LOW; score operacional 0/100

Nenhuma migration, DDL, DML, backfill ou probe de escrita foi executado durante a auditoria.

## Matriz de reconciliação

| Área | Banco real | Aplicação/repositório | Estado desejado | Prioridade |
|---|---|---|---|---|
| Tenancy | Entidades principais usam `user_id`; financeiro e Chatwoot têm ownership ausente/anulável | Guards e repositories usam usuário como tenant; service-role aparece em muitos fluxos | `organization_id` como boundary, memberships e autorização por capacidade | P0/P1 |
| Financeiro | Quatro tabelas com policy `ALL`, `USING(true)` e `WITH CHECK(true)`; 8 linhas sem tenant | Upsert financeiro conflita por `bling_id` global | Contenção imediata por usuário, depois migração por organização e integração | P0 |
| Chatwoot | Três tabelas sem tenant; policy libera qualquer autenticado | Sync não persiste tenant; send/status autorizam por ID externo | Configuração, IDs e dados scoped pela organização/integração | P0/P2 |
| Bling | Credenciais em tabela pública tenant-aware e tabela legada sem tenant | OAuth/sync usam service-role, locks e cache por usuário | Credenciais em schema privado, conexão por organização, OAuth seguro | P0/P2 |
| RPCs | RPCs aceitam tenant do chamador; função definer anônima; função de estoque pública | Aplicação envia `p_user_id` e chama RPCs diretamente | Identidade derivada da sessão ou execução exclusivamente server-side | P0 |
| Grants | `anon` possui privilégios amplos, inclusive `TRUNCATE` | O app deveria depender apenas de Data API/RLS ou adapters server-side | Menor privilégio por role e operação | P0 |
| NFe | `nfe` e `nfes` coexistem | Código atual usa o modelo tenant-aware | `nfes` canônica; legado aposentado por migration | P0/P1 |
| Migrations | Ledger MCP vazio; 19 tabelas, 20 policies, 14 funções, 23 triggers | SQL numerado contraditório e schema mestre inválido | Baseline declarativa e migrations forward-only reproduzíveis | P0 |
| Triggers/FKs | Triggers duplicados e FKs duplicadas com ações conflitantes | Regras também aparecem em serviços/routes | Uma regra durável por responsabilidade, coberta por teste | P1 |
| Sync/jobs | `sync_state` é tenant-aware, mas locks/RPCs divergem | Erros são engolidos e checkpoint avança após falha parcial | Inbox/outbox, lease durável e checkpoint atômico | P2 |
| Produção | `pg_stat_statements`, `pg_cron`, Vault e pgcrypto instalados | Sem observabilidade e CI completo | Telemetria, audit log, backup/restore e gates de deploy | P3 |

## Problem Statement

O ORBITA possui um banco de produção funcional, mas seu modelo de dados, políticas e funções ainda refletem uma aplicação de usuário único parcialmente migrada para multitenancy. A aplicação usa service-role em fluxos críticos e o banco contém regras permissivas ou inconsistentes. Isso permite exposição ou corrupção cross-tenant, impede que colaboradores compartilhem uma organização corretamente e torna o deploy não reproduzível.

O banco real e o código também divergiram: não há histórico registrado de migrations, existem objetos legados e duplicados, e algumas estruturas esperadas pelo código não correspondem ao schema implantado. Sem uma fonte de verdade e um plano expand/backfill/contract, corrigir apenas o código ou apenas o banco criará novas incompatibilidades.

## Solution

Executar uma transformação incremental em cinco estágios:

1. Conter imediatamente as exposições usando o modelo atual de `user_id`, sem esperar a reforma completa do SaaS.
2. Criar uma baseline reproduzível do banco real e uma cadeia canônica de migrations.
3. Introduzir organizações, memberships e autorização por capacidade em modo expand/backfill/contract.
4. Migrar Bling, Chatwoot, financeiro, webhooks e sync para boundaries por organização/integração.
5. Adicionar confiabilidade operacional, testes multitenant e gates de produção.

O ORBITA continuará como monólito modular. O banco será uma fronteira defensiva independente: RLS, constraints e grants continuarão protegendo dados mesmo quando um route handler ou adapter cometer um erro.

## User Stories

1. Como proprietário, quero criar uma organização, para que os dados da empresa não dependam diretamente da minha conta pessoal.
2. Como proprietário, quero convidar colaboradores, para que a equipe trabalhe no mesmo tenant.
3. Como proprietário, quero atribuir capacidades aos membros, para que ações financeiras, administrativas e operacionais sejam separadas.
4. Como colaborador, quero acessar apenas organizações das quais sou membro, para que dados de outras empresas permaneçam privados.
5. Como colaborador, quero alternar entre organizações autorizadas, para trabalhar em mais de uma empresa sem misturar contexto.
6. Como usuário autenticado, quero que toda consulta seja automaticamente limitada à organização ativa, para não depender de IDs enviados pelo navegador.
7. Como proprietário, quero configurar uma conexão Bling para minha organização, para que credenciais não sejam globais.
8. Como proprietário, quero configurar uma conexão Chatwoot para minha organização, para que conversas e contatos não colidam com outras contas.
9. Como operador, quero saber quando uma integração está saudável, degradada ou desconectada, para agir antes de perder dados.
10. Como operador, quero reprocessar eventos sem duplicar efeitos, para recuperar falhas com segurança.
11. Como operador, quero que checkpoints avancem somente depois do lote confirmado, para evitar perda silenciosa.
12. Como operador, quero que webhooks repetidos sejam reconhecidos, para evitar pedidos, mensagens ou títulos duplicados.
13. Como operador, quero que falhas externas retornem erros claros, para não confundir indisponibilidade com lista vazia.
14. Como responsável financeiro, quero títulos, categorias, contas e fornecedores isolados por organização, para preservar confidencialidade e integridade.
15. Como responsável financeiro, quero IDs do Bling scoped pela conexão, para evitar colisões entre contas.
16. Como responsável de estoque, quero que mutações exijam autorização e tenant verificado, para impedir alterações anônimas ou cross-tenant.
17. Como responsável fiscal, quero uma única representação canônica de NFe, para evitar dados divergentes.
18. Como usuário, quero que exclusões respeitem ownership e regras de retenção, para não remover dados de outra organização.
19. Como administrador, quero que funções privilegiadas tenham grants mínimos, para que não sejam executadas anonimamente.
20. Como administrador, quero que tabelas sensíveis não sejam expostas diretamente pela Data API, para reduzir a superfície de ataque.
21. Como auditor, quero um histórico imutável de ações sensíveis, para investigar alterações e incidentes.
22. Como suporte, quero correlation IDs entre request, job, webhook e provedor, para diagnosticar falhas ponta a ponta.
23. Como desenvolvedor, quero inicializar um banco vazio a partir das migrations, para reproduzir ambientes com confiança.
24. Como desenvolvedor, quero detectar drift entre banco e Git, para impedir mudanças manuais invisíveis.
25. Como desenvolvedor, quero testar RLS com tenants A e B, para provar negações e não apenas a existência de policies.
26. Como desenvolvedor, quero contract tests dos adapters, para detectar mudanças de Bling e Chatwoot.
27. Como responsável pelo deploy, quero separar migration, aplicação e backfill, para controlar risco e rollback.
28. Como responsável pelo deploy, quero health e readiness reais, para não direcionar tráfego a uma versão incapaz de operar.
29. Como responsável pelo negócio, quero planos, assinatura e limites por organização, para operar o ORBITA como SaaS.
30. Como responsável pelo negócio, quero suspender ou encerrar uma organização preservando retenção e auditoria, para cumprir o ciclo de vida do cliente.
31. Como responsável por segurança, quero que nenhum segredo seja versionado ou retornado pela API, para limitar comprometimento.
32. Como responsável por segurança, quero revogar acessos de um membro sem alterar ownership dos dados, para responder a desligamentos imediatamente.
33. Como responsável por segurança, quero que service-role ainda aplique tenant predicates no adapter, para que o bypass de RLS não vire bypass de autorização.
34. Como responsável por performance, quero índices alinhados aos filtros de organização e às FKs, para que RLS não degrade com crescimento.
35. Como responsável por confiabilidade, quero backups e restores ensaiados, para recuperar falhas de migration ou operação.

## Implementation Decisions

- O modelo final de tenancy será organização + membership; usuário não será o tenant.
- A contenção P0 usará o ownership atual sempre que ele já for confiável. A migração para organizações ocorrerá depois, evitando manter policies abertas enquanto a reforma estrutural é construída.
- A organização ativa será resolvida no servidor a partir da sessão e da membership. IDs de organização enviados pelo cliente serão tratados apenas como seleção e sempre revalidados.
- Toda entidade de negócio do tenant terá `organization_id NOT NULL` no estado final.
- Relações que carregam ownership usarão constraints compostas para impedir referência entre organizações.
- IDs externos serão únicos por conexão de integração, não globalmente. A entidade de negócio também armazenará a organização para RLS e consultas.
- Policies serão separadas por comando, explicitamente scoped a roles e terão `USING` e `WITH CHECK` quando aplicável. Policies `FOR ALL` não serão o padrão.
- Grants serão deny-by-default. Roles de navegador não terão `TRUNCATE`, `TRIGGER` ou `REFERENCES`, e só receberão operações necessárias aos contratos públicos.
- Funções de usuário derivarão identidade de `auth.uid()`; funções server-only serão revogadas de `PUBLIC`, `anon` e `authenticated` e concedidas somente à role necessária.
- Funções privilegiadas terão search path imutável e referências schema-qualified.
- Credenciais de integração ficarão em schema privado, sem exposição PostgREST, criptografadas com chave versionada e acessíveis apenas pelo adapter server-side.
- O modelo canônico fiscal será único. Objetos legados serão aposentados apenas depois de busca de dependentes, backfill e verificação.
- Regras universais de integridade ficarão em constraints. Triggers serão mantidos apenas para invariantes pequenas, determinísticas e não duplicadas.
- Jobs terão lease/checkpoint durável por conexão e entidade. Falha parcial não confirmará checkpoint.
- Webhooks serão persistidos em inbox idempotente antes dos efeitos; efeitos externos usarão outbox quando precisarem de retry.
- Migrations serão forward-only. Mudanças arriscadas seguirão expand, backfill observável e resumível, validação, contract e remoção posterior.
- O estado real do banco será baseline de reconciliação, mas não será aceito cegamente como schema desejado.
- Nenhuma alteração será aplicada diretamente em produção antes de passar por ambiente descartável e staging.

## Testing Decisions

O principal seam será uma suíte de integração contra Supabase descartável que:

- cria o banco exclusivamente pelas migrations;
- cria organizações A e B, owner, colaborador e usuário externo;
- executa CRUD e RPCs sob `anon`, `authenticated` e adapter server-side;
- prova acesso autorizado e negação cross-tenant;
- valida constraints, grants, policies, views e funções;
- executa backfills duas vezes para provar idempotência;
- valida rollback lógico e compatibilidade durante expand/backfill/contract;
- verifica inbox/outbox, replay e checkpoint após falha parcial.

Testes unitários cobrirão regras de domínio e autorização sem Supabase. Contract tests cobrirão Bling e Chatwoot. Playwright cobrirá somente login, seleção/criação de organização, convite, conexão de integração e uma operação crítica ponta a ponta.

Testes devem observar comportamento externo. Não devem afirmar nomes internos de funções, implementação de repositories ou quantidade de queries, salvo testes específicos de migration/performance.

Os gates mínimos serão:

1. secret scan;
2. bootstrap de banco vazio;
3. lint SQL e advisors;
4. testes RLS tenant A/B;
5. testes de integração/RPC;
6. unitários e contracts;
7. typecheck e lint;
8. build;
9. Playwright crítico;
10. audit de dependências e AI slop.

## Plano de entrega sincronizado

### P0-A — Contenção sem reforma de tenancy

- Revogar execução pública/anônima das funções privilegiadas e mutadoras.
- Fixar search path das funções privilegiadas.
- Revogar privilégios destrutivos e grants desnecessários de roles de navegador.
- Fechar as quatro policies financeiras permissivas.
- Enquanto ownership financeiro estiver ambíguo, bloquear acesso direto de navegador e permitir apenas adapter server-side com tenant verificado.
- Fechar Chatwoot ao acesso direto até existir tenant confiável.
- Corrigir os endpoints públicos e IDORs já identificados no código.
- Rotacionar segredos versionados e limpar histórico.

Gate: nenhum CRITICAL do banco permanece; nenhum endpoint conhecido ignora tenant; produção continua funcional pelos adapters controlados.

### P0-B — Baseline e migrations canônicas

- Exportar schema sanitizado do banco real.
- Mapear cada objeto live para migration local, legado ou drift manual.
- Criar um baseline que inicializa banco vazio sem duplicar DDL em produção.
- Corrigir ordem, nomes, dependências e scripts contraditórios.
- Adicionar CI de bootstrap e drift.

Gate: banco vazio e staging convergem para o mesmo schema esperado; ledger de migrations passa a ser autoritativo.

### P0-C — Saneamento de dados e estrutura atual

- Classificar as seis categorias financeiras e os dois títulos sem tenant.
- Quarentenar registros cuja origem não possa ser provada.
- Adicionar ownership a fornecedores.
- Tornar ownership obrigatório depois do backfill.
- Substituir unicidades globais por escopo temporário de tenant/conexão.
- Consolidar NFe, FKs e triggers duplicados.

Gate: zero tenant nulo, órfão ou mismatch; constraints e triggers canônicos aprovados em staging.

### P1 — Organizações e memberships

- Criar organizações, memberships, convites e capacidades.
- Criar uma organização para cada tenant atual comprovado.
- Adicionar `organization_id` sem remover `user_id` inicialmente.
- Fazer dual-read/dual-write controlado e validar equivalência.
- Migrar RLS, FKs e índices para organização.
- Remover dependência de ownership direto do usuário somente após todos os callers migrarem.

Gate: owner e colaborador compartilham a organização; usuário externo é negado em todos os seams.

### P2 — Integrações, jobs e eventos

- Criar conexões e credenciais privadas por organização.
- Migrar Bling e Chatwoot para adapters por conexão.
- Implementar inbox/outbox, replay protection e idempotency keys.
- Mover sync para execução durável fora do request HTTP.
- Tornar checkpoint e confirmação de lote atômicos.

Gate: retries, replays e falhas parciais não duplicam nem perdem dados.

### P3 — Produto SaaS e operação

- Implementar planos, assinatura, limites e lifecycle da organização.
- Adicionar audit log, logger estruturado, métricas, tracing e alertas.
- Criar health/readiness, backup, restore e rollback ensaiados.
- Automatizar deploy com migration job separado.

Gate: staging reproduz produção, restore é comprovado e deploy pode ser revertido.

### P4 — Modularização e acabamento

- Extrair slices verticais de tenancy, integrações, financeiro, pedidos e observabilidade.
- Remover fallbacks silenciosos, `any` em fronteiras e scripts descartáveis.
- Decompor módulos grandes depois que os testes comportamentais existirem.

Gate: gates completos verdes, documentação e ADRs atualizados, sem dependências cruzadas não autorizadas.

## Out of Scope

- Aplicar migrations ou backfills nesta especificação.
- Realizar pentest, probes de escrita ou testes com dados reais de usuários.
- Microsserviços, Kubernetes ou event sourcing completo.
- Trocar Supabase, Bling ou Chatwoot.
- Construir aplicativo mobile.
- Adicionar novos provedores antes de estabilizar os atuais.
- Otimizações de escala sem métricas reais.

## Further Notes

- O banco real contém 19 tabelas públicas, 20 policies, 14 funções, uma view e 23 triggers, mas o MCP não encontra migrations registradas.
- Todas as tabelas públicas têm RLS habilitada; isso é positivo, mas não compensa policies permissivas ou role-only.
- Não existem buckets de Storage, reduzindo a superfície imediata.
- Os agregados não encontraram órfãos, mismatches cross-tenant ou external IDs duplicados nos relacionamentos testáveis.
- Há seis categorias financeiras e dois títulos financeiros sem tenant; nenhuma atribuição automática deve ocorrer sem origem comprovada.
- A instalação local do Database Sentinel continua incompleta; a auditoria seguiu as referências verificadas da distribuição oficial em cache temporário.
- A configuração MCP permanece somente leitura. Escrita futura exigirá autorização separada, migration revisada, rollback e staging.
- Não existe configuração de issue tracker no repositório, então esta spec foi publicada localmente em `docs/` e não recebeu label `ready-for-agent` externa.
