# Ticket 12 — Auditoria de durabilidade (inbox / outbox / jobs)

Auditoria do estado real antes de qualquer código novo, conforme protocolo do
ticket 12. Não é permitido criar uma segunda fila concorrente: este documento
existe para provar que o que já existe foi lido e entendido antes de decidir o
que falta.

## O que já existe (invariantes confirmados)

### Inbox — `database/28_inbox_idempotente_bling.sql`, `29_inbox_idempotente_chatwoot.sql`

- Tabelas `inbox_eventos_bling` / `inbox_eventos_chatwoot`, únicas por
  `(organizacao_id, idempotency_key)` — `uq_inbox_eventos_*_org_key`.
- `registrar_evento_inbox_*`: `SELECT ... FOR UPDATE` na chave de idempotência
  antes do insert — reserva atômica; duplicata retorna o registro existente e
  `cached_response` em vez de reprocessar.
- `concluir_evento_inbox_*`: grava `status`, `last_error`, `attempts + 1`,
  `processed_at` condicional.
- `preparar_replay_evento_inbox_*`: transição para `processing`, devolve o
  payload original para reprocessamento — não altera o payload.
- RLS por organização (`usuario_pertence_a_organizacao`); grants mínimos
  (`service_role`/`authenticated` apenas onde necessário).
- Serviços: `src/services/blingInboxService.ts`, `src/services/chatwootInboxService.ts`
  (e o novo `src/services/chatwoot/chatwootWebhookService.ts` +
  `chatwootWebhookPersistence.ts` do ticket 11, que já consomem esse inbox
  corretamente: autentica antes de confiar, registra no inbox antes de aplicar
  efeitos, marca processed/failed depois).

**Gaps reais:**
1. `status` só tem `received/processing/processed/failed/ignored` — não existe
   `retryable` nem `dead` como pede a máquina de estados do ticket
   (`received→processing→processed|retryable|dead`). Hoje `failed` é terminal
   e só sai dali via replay manual — não há "max attempts" automático nem
   distinção entre falha transitória (deveria voltar para fila) e falha
   definitiva (dead-letter).
2. Nenhum evento de inbox carrega `correlation_id`. O webhook Chatwoot já gera
   correlação HTTP (`src/lib/observability/correlation.ts`) mas não persiste
   no inbox, quebrando a correlação `request→inbox→job→outbox→provider`
   exigida pelo ticket.
3. Não há teste pgTAP de concorrência (dois processos tentando
   `registrar_evento_inbox_*` com a mesma `idempotency_key` ao mesmo tempo) —
   apenas teste sequencial de duplicata (`supabase/tests/database/inbox_idempotente_*`).
4. `attempts` é incrementado em toda chamada de `concluir_evento_inbox_*`, mas
   nenhum caller compara contra um teto — retry via replay é hoje
   ilimitado (mitigado por ser uma ação manual/autorizada, não automática).

### Jobs — `database/30_jobs_sync_duraveis.sql`

- Tabela `sync_jobs` com índice parcial único
  `uq_sync_jobs_org_active` — impede dois jobs `queued`/`running`
  simultâneos por organização.
- `adquirir_lease_job_sync`: `SELECT ... FOR UPDATE SKIP LOCKED` real — dois
  workers não podem adquirir o mesmo lease; TTL configurável, checa
  `lease_expires_at` antes de aceitar reentrância.
- `avancar_checkpoint_job_sync`: grava progresso e renova lease a cada lote —
  crash entre lotes não perde o progresso já confirmado.
- `liberar_leases_expirados_sync`: reaper que devolve jobs `running` com lease
  vencido para `queued` — crash recovery real, não é timer em memória.
- `src/repositories/syncJobRepository.ts` + `src/services/sync.ts`: worker
  já é código invocável (`syncService.processJob`), sem `setTimeout`/timer
  obrigatório; chama `releaseExpiredLeases()` antes de tentar o lease.

**Gaps reais:**
1. Estados são `queued/running/completed/failed/cancelled` — o ticket pede
   `queued→running→succeeded|retryable|dead|cancelled`. Não existe
   `retryable` (falha transitória reencurada automaticamente) nem `dead`
   (falha definitiva após N tentativas); hoje uma falha é sempre terminal
   (`failed`) e só é retentada se alguém chamar `enqueueSync` de novo
   manualmente — não há `attempts`/`max_attempts` na tabela.
2. Sem `correlation_id` na tabela — mesmo problema do inbox.
3. `adquirir_lease_job_sync` não grava um `lease_owner` (id do worker) — o
   lock físico do Postgres garante exclusão mútua, mas não há como provar
   *qual* worker detém o lease para auditoria/observabilidade, nem para
   permitir que o próprio worker libere o lease de forma explícita no
   shutdown (hoje só o reaper por TTL libera).

### Outbox — `database/31_outbox_retries_saude_integracoes.sql`

- Tabela `outbox_eventos`, única por `(organizacao_id, idempotency_key)`.
- `registrar_evento_outbox`: mesma reserva atômica idempotente do inbox.
- `reivindicar_lote_outbox`: `FOR UPDATE SKIP LOCKED` real, lote limitado,
  ordenado por `next_retry_at`; dois workers não roubam o mesmo evento.
- `concluir_evento_outbox`: classifica erro, aplica backoff exponencial
  (`next_retry_at`), promove a `dead_letter` ao atingir `max_attempts`,
  atualiza `health_status` da conexão.
- `src/services/outboxService.ts`: `classifyError`/`calculateBackoffSeconds`/
  `sanitizeErrorMessage` já existem e já redigem segredos antes de persistir.

**Gaps reais (o mais crítico do ticket):**
1. **Nenhum lease/expiração no estado `processing`.** `reivindicar_lote_outbox`
   move o evento para `processing` mas não grava `lease_owner` nem
   `lease_expires_at`, e não existe reaper equivalente ao
   `liberar_leases_expirados_sync`. Se um worker morre depois de reivindicar
   um lote e antes de chamar `concluir_evento_outbox`, o evento fica preso em
   `processing` **para sempre** — viola diretamente o critério de aceitação
   "Crash e reinício retomam do checkpoint seguro" e a regra "não ter retry
   infinito" (aqui é o oposto: retry zero, perda silenciosa).
2. `concluir_evento_outbox` não verifica posse do lease — qualquer chamada
   com o `evento_id` completa o evento, mesmo vindo de um worker "zumbi" cujo
   lease já expirou e cujo item outro worker já reclamou. Duas conclusões
   concorrentes do mesmo evento não são impedidas no nível de RPC.
3. Sem `correlation_id`.
4. **Nenhum worker invocável existe.** `outboxService.claimBatch/markSent/
   markFailed` são só os três métodos de acesso a dado — não há nenhum módulo
   em `src/` que efetivamente chama `claimBatch`, despacha para um adapter de
   provider e resolve sent/failed. `grep -RIl "worker|dispatcher"` não retorna
   nada em `src`. Isso é o gap mais direto do "Plano determinístico" item 5 do
   ticket ("Worker é processo invocável/testável").
5. Nenhum teste pgTAP cobre: dois workers reivindicando o mesmo lote
   concorrentemente, lease expirado sendo re-reivindicado, heartbeat,
   tentativa máxima combinada com dead-letter observável via contador, ou
   crash antes/depois do efeito externo.

## Decisão de escopo (não criar segunda fila)

Toda a infraestrutura de idempotência, lease-claim com `SKIP LOCKED` e
backoff/dead-letter já existe e é sólida nas três tabelas. O ticket 12 não
será implementado criando uma nova fila: as migrations novas **alteram** as
três tabelas existentes (`ALTER TABLE ... ADD COLUMN`, novas RPCs
complementares) e o worker novo consome exclusivamente
`outbox_eventos`/`reivindicar_lote_outbox`.

Gaps endereçados nesta entrega (dentro do domínio de durabilidade):
- Lease owner/expiração + reaper para `outbox_eventos` (fecha o gap crítico).
- `concluir_evento_outbox` passa a exigir posse do lease vigente.
- Coluna `correlation_id` em `inbox_eventos_bling`, `inbox_eventos_chatwoot`,
  `sync_jobs`, `outbox_eventos`, propagada pelos callers existentes.
- Worker de outbox invocável (`src/services/outbox/outboxWorker.ts`),
  testável sem timer em memória, com shutdown que libera o lease.
- pgTAP de concorrência/lease/reaper/duplicata para outbox.
- Teste de reinício (integração) provando retomada sem duplicar efeito.

Gaps que ficam fora desta entrega, registrados como `needs-owner` no
checkpoint e na evidência final: renomeação completa da máquina de estados de
`sync_jobs`/inbox para os nomes literais `retryable`/`dead`/`succeeded` (hoje
`completed`/`failed` cumprem o mesmo papel semântico sem o nome exato) e rota
HTTP privilegiada de replay para outbox (inbox já tem
`preparar_replay_evento_inbox_*`; outbox hoje só permite replay indireto via
reenfileiramento, não há um comando de replay dedicado com auditoria).
