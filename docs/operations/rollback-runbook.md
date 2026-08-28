# Runbook — Rollback de deploy e correção forward-only de migration

Escopo: ORBITA aplicação (Next.js) + banco Supabase/PostgreSQL. Aplica-se a staging e produção
quando existirem (hoje `needs-owner` — ver `docs/adr/ticket-21-deploy-staging.md`). A lógica e os
sinais abaixo foram desenhados e, onde possível, ensaiados no laboratório Postgres local
descartável desta branch; o ensaio em staging real fica `needs-owner`.

## Princípio: rollback app-first

O banco nunca é revertido automaticamente. Migrations são **forward-only** (ver `AGENTS.md` e
`$orbita-database`): nunca reescrever histórico de migration já aplicado. Um deploy problemático é
corrigido revertendo a **aplicação** para o commit anterior (deploy anterior), mantendo o schema do
banco parado no estado mais avançado — porque uma migration forward-only já aplicada normalmente é
compatível com a versão anterior do código (expand antes de contract), e reverter o banco arrisca
perda de dados escritos pela versão nova entre o deploy e a decisão de rollback.

Se a migration nova não for retrocompatível com o código anterior (ex.: uma coluna `NOT NULL` sem
default que o código antigo não preenche), a migration deve ter sido desenhada em fases
expand/backfill/contract (`$orbita-database`) — o rollback de aplicação usa a fase "expand", nunca
pula direto para "contract".

## Sinais que disparam a decisão

- Readiness (`GET /api/readiness`) reportando `not_ready` de forma sustentada pós-deploy (não um
  blip único) — ver `src/app/api/readiness/route.ts`.
- Startup probe (`GET /api/health/startup`) reportando `not_ready` — schema baseline ausente ou
  config inválida logo após o deploy.
- Taxa de erro 5xx acima do baseline nas rotas críticas (auth, sync, webhooks) — telemetria do
  Ticket 19.
- Alerta crítico do Ticket 19 disparado (quando o canal real existir — `needs-owner`; a interface já
  é testável localmente).
- Falha de smoke pós-deploy na jornada crítica (criação de organização, login, sync inicial).

## Decisão

1. **Responsável de plantão** (`needs-owner` — nome/rota de contato definidos pelo proprietário)
   confirma o sinal com pelo menos duas fontes independentes (ex.: readiness + taxa de erro), para
   evitar rollback por ruído de um único probe.
2. Se confirmado: reverter a aplicação para o deploy anterior (redeploy do commit anterior, ou
   rollback nativo do provider de hosting — `needs-owner`, depende do provider escolhido no ADR).
3. Banco **não é revertido**. Se a causa raiz for uma migration específica com efeito ativo e nocivo
   (ex.: um trigger causando erro em toda escrita), aplicar uma **migration corretiva forward-only**
   nova (próximo número na sequência, nunca editar a migration já aplicada) que desliga/corrige o
   comportamento — nunca uma migration destrutiva embutida no boot da aplicação (proibido pelo
   ticket 21 e verificado: `src/app/api/health/startup/route.ts` só lê schema, nunca migra).

## Comunicação

- Registrar o incidente (canal/ferramenta definidos pelo proprietário — `needs-owner`) com:
  horário de início, sinal que disparou, ação tomada (rollback de app e/ou migration corretiva),
  horário de resolução.
- Notificar os responsáveis pelos módulos afetados (ex.: integração Bling/Chatwoot/Stripe) se o
  rollback afetar contratos externos (webhooks pendentes, sessões de checkout em andamento).

## Preservação de eventos/jobs

- Jobs duráveis (`sync_jobs`, outbox — Ticket 12) persistem em banco, não em memória: um rollback de
  aplicação não perde jobs enfileirados, porque o worker seguinte (rodando a versão revertida ou a
  corrigida) continua consumindo da mesma tabela.
- Eventos de auditoria (`eventos_auditoria_sistema`, `catalogo_eventos_auditoria` — Tickets 19/20)
  não são apagados por rollback de aplicação; um rollback é ele mesmo registrado como evento
  operacional quando o canal de auditoria real existir.
- Webhooks recebidos durante a janela de rollback continuam idempotentes (`inbox_eventos_bling`,
  `inbox_eventos_chatwoot` — chave de idempotência já garantida pelas migrations 28/29): reprocessar
  após o rollback não duplica efeito.

## Ensaio local realizado nesta branch (laboratório descartável, não staging real)

O ensaio de "correção forward-only de migration" foi validado indiretamente pelo próprio mecanismo
de laboratório local (`scripts/database-lab.mjs` → `runFailureRehearsal`): esse mecanismo já prova,
a cada execução de `npm run test:db`, que uma falha no meio da cadeia de migrations (`failAfterOrder`)
interrompe a aplicação sem deixar o laboratório em estado inconsistente, e que a cadeia de migrations
é estritamente sequencial e re-executável do zero (dois ciclos limpos com fingerprint de catálogo
idêntico). Isso é a mesma garantia estrutural que sustenta "aplicar uma migration corretiva forward-only
sem reescrever histórico": o ledger (`database/migrations.lock.json`) trava ordem e checksum de cada
migration já aplicada, então uma correção só pode ser um novo arquivo no final da sequência.

O ensaio de rollback de **aplicação** (reverter para um deploy anterior real, servido por um host
real) e o ensaio de comunicação/plantão real ficam `needs-owner`, pois dependem do host/staging real
definidos no ADR.

## `needs-owner`

- Definir o responsável de plantão e o canal de comunicação de incidente.
- Provisionar o mecanismo de rollback do provider de hosting escolhido (redeploy de commit anterior).
- Ensaiar este runbook fim-a-fim em staging real (deploy → sinal → decisão → rollback → comunicação)
  quando staging existir.
