# Contração das chaves globais do Chatwoot (MSG-004) — migration 87_contrair_chaves_globais_chatwoot.sql

Contract do expand/migrate/contract da identidade Chatwoot (MSG-002 → MSG-003A/B
→ MSG-004). Depois desta migration o id numérico do Chatwoot não é chave em
lugar nenhum: duas organizações, ou duas instalações da mesma organização,
coexistem com os mesmos ids remotos.

## 1. Inventário de dependências da chave global (cadeia 01–85, ledger 88)

Medido no laboratório (`pg_constraint`, `pg_index`, `pg_trigger`, corpo das
funções que citam os espelhos) e no código (`rg` em `src/`, `scripts/`,
`supabase/tests/`).

| Dependência | Onde | Efeito com duas instalações | Tratamento |
|---|---|---|---|
| PK `id` nas três tabelas | 27 | a 2ª instalação não grava o id 5 | PK = `id_local` (reaproveita o índice único da 85) |
| FKs `contact_id` → contatos(id), `conversation_id` → conversas(id) | 27 | vínculo pelo id remoto, sem organização | removidas; vínculo = FK composta `(organizacao_id, *_id_local)` da 85 |
| `uq_chatwoot_*_org_id (organizacao_id, id)` | 27/55 | 2ª instalação da mesma organização recusada | removidos |
| `uq_chatwoot_*_identidade_remota` NULLS DISTINCT | 85 | linha legada sem conexão duplicável | recriados `NULLS NOT DISTINCT` |
| CHECK `id_externo = id::text` | 85 | nenhum (eco coerente) | **mantido**: `id` vira eco sem papel de chave |
| `fn_sync_chatwoot_{conversations,messages}_organizacao` | 27 | `select ... where id = new.contact_id` pega o pai de outra organização e recusa a escrita legítima | pai pelo UUID local |
| `chatwoot_conexao_da_mensagem` | 85 | devolve a **primeira** conversa com o id (palpite) | pela conversa local |
| `chatwoot_conexao_da_conversa` | 85 | subconsulta escalar quebra com 2 mapeamentos do inbox | prova só se o mapeamento for único |
| `chatwoot_conexao_do_contato` | 85 | conversas pelo `contact_id` de outra instalação | pelas conversas ligadas ao UUID |
| `chatwoot_{contato,conversa}_local` | 85 | buscavam `id` | buscam `id_externo` (mesma semântica, contagem = 1) |
| `backfill_identidade_local_chatwoot` | 85 | `where id in (...)` toca a linha de outra organização e reinicia o relógio de retenção dela | seleciona e atualiza pelo UUID |
| `uq_chatwoot_inboxes_org_inbox` | 27 | o inbox 1 da 2ª instalação não é mapeado (23505 engolido pelo registro) | removido; fica `(conexao_id, inbox_id)` (47) |
| `uq_inbox_eventos_chatwoot_org_key` + RPC `registrar_evento_inbox_chatwoot` | 29 | a mensagem 500 da 2ª instalação é "duplicata" da 1ª e é descartada com 200 | dedup por organização + conexão + chave |
| Retenção: seletor, exclusão, reaplicação no restore | 51 | apagar o contato 5 de A1 apaga o 5 de A2 | pelo UUID local; ver §5 |
| `retencao_marcar_legal_hold` | 51 | hold pelo id remoto protege as duas instalações (ou nenhuma) | recusa id remoto para contato Chatwoot |
| `verificar_integridade_baseline` | 19 | acusa vínculo cruzado inexistente | mensagem × conversa pelo UUID |
| `SupabaseRetentionDatabasePort.entityExists` | código | `.eq('id', Number(...))` | `.eq('id_local', uuid)` |
| Webhook, sync, envio, status, navegador, Realtime | código | — | já pelo UUID (MSG-003A/B); detector `chavesGlobaisChatwoot.test.ts` |

Nenhum caller necessário depende mais da chave global (detector + rg). As
colunas `id`, `contact_id` e `conversation_id` ficam como dado: o adapter já as
grava e o código do MSG-003B continua compatível (rollback sem SQL). Remover as
colunas é limpeza posterior.

## 2. Quarentena fail-closed

- Linha **nova** sem organização ou sem conexão provada é recusada (`23514`).
  Prova aceita: mapeamento de inbox único na organização, pai local, ou conversas
  ligadas ao contato. Não nasce mais quarentena.
- Linha **legada** (sem conexão, de antes do MSG-004) só é adotada pela conexão
  que a prova aponta ou pela única conexão Chatwoot da organização.
- Em organização com mais de uma conexão Chatwoot, linha legada não recebe
  conteúdo sem ser adotada (`23514`). O status de conversa legada já não é
  aplicado pelo código (correção do MSG-003A); o banco repete a regra.
- Relação que só existe pelo id remoto (conversa sem `contato_id_local`,
  mensagem sem `conversa_id_local`) ou espelho sem organização **impede a
  migration** (preflight).

## 3. GO/NO-GO (somente leitura, no alvo)

```sql
-- 1. ledger em 88 (85_identidade_local_chatwoot.sql) e colunas da 85
select count(*) from information_schema.columns
 where table_schema = 'public' and column_name = 'id_local'
   and table_name in ('chatwoot_contacts', 'chatwoot_conversations', 'chatwoot_messages');   -- 3
-- 2. preflight: precisa ser 0/0/0/0, senão a migration aborta sem mudar nada
select (select count(*) from public.chatwoot_conversations where contato_id_local is null) conversas_sem_contato,
       (select count(*) from public.chatwoot_messages where conversa_id_local is null) mensagens_sem_conversa,
       (select count(*) from public.chatwoot_identidade_em_quarentena where motivo = 'sem_organizacao') sem_organizacao,
       (select count(*) from public.chatwoot_conversations v join public.chatwoot_contacts c on c.id_local = v.contato_id_local
         where c.id <> v.contact_id or c.organizacao_id is distinct from v.organizacao_id)
     + (select count(*) from public.chatwoot_messages m join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
         where v.id <> m.conversation_id or v.organizacao_id is distinct from m.organizacao_id) vinculo_divergente;
-- 3. volume (lock): ver §4
select (select count(*) from public.chatwoot_contacts), (select count(*) from public.chatwoot_conversations),
       (select count(*) from public.chatwoot_messages), (select count(*) from public.inbox_eventos_chatwoot);
-- 4. a quarentena de conexão que vai ficar congelada (não bloqueia)
select tabela, motivo, count(*) from public.chatwoot_identidade_em_quarentena group by 1, 2;
```

NO-GO no item 2: resolver antes. A linha que só aponta para o pai pelo id
remoto é, na prática, de outra instalação (caso medido no laboratório: conversa
de c3 ligada a contato de c4). Decisão operacional por linha: apagá-la e deixar
o sync da conexão certa reimportá-la, ou ligá-la ao pai certo
(`update ... set contato_id_local = <uuid do pai na mesma conexão>`; o gatilho
confere). Rodar `backfill_identidade_local_chatwoot(1000)` antes, que resolve o
que já tem prova.

## 4. Aplicação

```bash
npm run db:remoto:status  -- --url "<connection>" --previa --ate-arquivo 87_contrair_chaves_globais_chatwoot.sql
npm run db:remoto:aplicar -- --url "<connection>" --confirmar --ate-arquivo 87_contrair_chaves_globais_chatwoot.sql
```

Uma transação; `lock_timeout = 5s`. `ACCESS EXCLUSIVE` em `chatwoot_contacts`,
`chatwoot_conversations`, `chatwoot_messages`, `chatwoot_inboxes` e
`inbox_eventos_chatwoot` até o commit (o webhook espera ou falha e o Chatwoot
reentrega; o inbox deduplica). Reconstrói três índices únicos e o índice de
eventos sem `CONCURRENTLY`. Medido no laboratório: 5 mil contatos, 10 mil conversas e
100 mil mensagens em 1,9 s (transação inteira, cliente incluído). Ao fim, `NOTICE`
com a quarentena restante.

Ordem: o código deste ticket (só o adapter de retenção e testes) é compatível
com S88 e com o schema contraído; o do MSG-003B também. Recomendado: publicar o
código → GO/NO-GO → aplicar → validar → só então cadastrar a segunda instalação
de qualquer organização.

| Código \ Banco | S88 (até a 85) | contraído |
|---|---|---|
| MSG-003B (com a correção do 003A) | compatível (estado atual) | compatível: o mesmo id em outra instalação passa a gravar em vez de `IdentidadeDeOutraConexao` |
| MSG-004 | compatível: `id_local` existe desde a 85; a RPC antiga ainda seleciona ids numéricos, que o preview trata como inexistentes (o adapter não está ligado a nenhuma rota) | compatível |

## 5. Retenção

- Novos itens, holds e tombstones de contato Chatwoot usam o UUID local.
- Holds pelo id remoto são traduzidos na migration (antes dela `(organizacao_id,
  id)` era único, a tradução é exata). Hold de linha já apagada fica como está.
- Item selecionado antes da migration (id remoto) é recusado na aplicação
  (`22023`): falha visível, a run não conclui como sucesso, a próxima seleciona
  pelo UUID.
- Tombstone antigo (id remoto) no restore apaga só a linha da organização com
  aquele id criada **até** o tombstone; um contato mais novo com o mesmo id (de
  outra instalação) não é apagado. Mais de uma candidata antiga é impossível
  pelo histórico e aborta a reaplicação (`23514`), sem palpite.

## 6. Validação depois de aplicar

```sql
select a.attname from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
 where k.conrelid = 'public.chatwoot_messages'::regclass and k.contype = 'p';                      -- id_local
select count(*) from pg_indexes where indexname in ('uq_chatwoot_contacts_org_id', 'uq_chatwoot_inboxes_org_inbox',
                                                   'uq_inbox_eventos_chatwoot_org_key');            -- 0
select sum(atualizadas) from public.backfill_identidade_local_chatwoot(1000);                       -- 0
select infracoes from public.verificar_integridade_baseline()
 where tabela = 'chatwoot_messages -> chatwoot_conversations';                                      -- 0
select count(*) from public.retention_legal_holds h join public.retention_policy_registry r on r.categoria = h.categoria
 where r.tabela_alvo = 'chatwoot_contacts' and h.liberado_em is null and h.entidade_id ~ '^[0-9]+$'; -- holds sem linha
```

## 7. Rollback (forward-only)

- Migration falhou: a transação desfaz tudo; corrigir a causa (preflight) e
  reaplicar.
- Código: reverter para o MSG-003B não exige SQL (escreve as mesmas colunas). O
  efeito é só perder a correção da retenção no adapter, que não está ligado a
  rota.
- Problema depois do commit: **não** recriar a PK por `id` nem os únicos por
  organização (com duas instalações isso falha ou, pior, volta a fundir
  tenants). Pausar o onboarding da segunda instalação e o processamento da
  conexão afetada (`status = 'desconectado'`), corrigir adiante com nova
  migration, reprocessar os eventos `failed` do inbox (idempotentes pelo UUID).
- Nunca restaurar grant amplo, apagar o ledger ou repetir POST de resultado
  desconhecido como recuperação.

## 8. Efeitos externos

Nenhum: a migration e o adapter não chamam o Chatwoot. Os 17 casos da matriz de
efeitos (timeout, ACK perdido, 2xx inválido) não se aplicam. O caso interno
equivalente — commit perdido do webhook durante o lock — é a reentrega do
Chatwoot, deduplicada por instalação.

## 9. Evidência

- `supabase/tests/final/chaves_globais_chatwoot.test.sql` (48): catálogo; A1, A2
  e B1 com 5/50/500 (árvores, replay do sync, status isolado, duplicata, vínculo
  cruzado); tradução UUID → conexão → id remoto e 404 cross-tenant; inbox de
  eventos; navegador e filtro do Realtime; retenção (seleção, hold, exclusão,
  item legado, restore com tombstone antigo); baseline; quarentena legada
  fail-closed. Contraprovas: único de eventos por organização (21), RPC sem
  conexão (22), leitura por id remoto (29), exclusão por id (38), baseline por
  id (43), sem a guarda de adoção (47).
- `supabase/tests/final/identidade_local_chatwoot.test.sql` (50, reescrito do
  MSG-002 para o schema contraído): coexistência no lugar da recusa por PK;
  escrita sem conexão recusada; backfill com falha no meio e retomada;
  contraprovas sem organização imutável, sem FK composta (e sem o gatilho da
  27), sem filtro de conexão e sem a chave composta.
- `supabase/tests/database/contracao_chaves_chatwoot.test.sql` (17): a migration
  sobre o snapshot expandido (85 aplicada a dados legados): aborto no preflight
  sem rastro, conclusão, conteúdo e `updated_at` idênticos, hold traduzido,
  quarentena preservada, backfill idempotente e retomável sem tocar a outra
  organização. Contraprovas medidas: sem preflight → 1; sem traduzir hold → 9;
  backfill por `id` → 13 e 16.
- `scripts/database-concurrency-contracao-chatwoot.mjs` (em `test:db`):
  eventos e árvores de três instalações em paralelo sem espera; mesma
  instalação → espera + 23505 + reentrega deduplicada; retenção de A1 × webhook
  de A2 sem bloqueio nem efeito cruzado.
- `scripts/database-concurrency-identidade-chatwoot.mjs` e
  `database-concurrency-resolver-chatwoot.mjs`: as corridas do MSG-002/003A no
  schema contraído.
- `src/services/privacy/adapters/retentionDbAdapter.test.ts` e
  `src/lib/chavesGlobaisChatwoot.test.ts`.

Limitações: o laboratório não sobe PostgREST nem Realtime; o store e a leitura
do navegador são provados pelas mesmas instruções SQL e pela RLS, e o filtro do
Realtime pelo predicado `conversa_id_local = <uuid>` sob RLS. Nenhuma chamada
real ao Chatwoot; nenhum SQL remoto.

## 10. Matriz por corte do ledger (pgTAP)

No laboratório privado, com o ledger cortado em cada ordem e o banco limpo (os
pgTAP rodam antes dos ensaios, como no `test:db`):

| Arquivo | S88 (até a 85) | S90 (com a 87) |
|---|---|---|
| `supabase/tests/corte_s88/identidade_local_chatwoot.test.sql` (o pgTAP final da 85, sem alteração: fase expand) | **50/50** | falha por desenho (34/50): afirma a PK por `id` e o sync sem conexão |
| `supabase/tests/final/identidade_local_chatwoot.test.sql` (reescrito, pós-contração) | falha por desenho | **50/50** |
| `supabase/tests/final/chaves_globais_chatwoot.test.sql` | falha por desenho | **48/48** |
| os outros 7 pgTAP finais | verdes | verdes |

O `test:db` oficial roda só `supabase/tests/final` sobre a cadeia inteira. A
fase expand continua provada pelo arquivo do corte S88:

```bash
# laboratório com o ledger cortado na ordem 88 (sem a 87)
npx supabase test db supabase/tests/corte_s88 --local
```
