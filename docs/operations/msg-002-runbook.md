# Identidade local do Chatwoot (MSG-002) — migration 85

Expand do expand/migrate/contract da identidade Chatwoot. Este ticket entrega o
modelo novo, o backfill e a escrita compatível. Os callers migram para o UUID no
MSG-003A; a contração das chaves globais é do MSG-004.

> **Numeração provisória.** O arquivo `85_identidade_local_chatwoot.sql` (ordem
> 88) depende da base final que a coordenação definir depois do PRE-008. Se o
> PRE-008 criar outra migration, este arquivo é renumerado e o ledger, o
> `schema_paths`, o catálogo e o drift test são regenerados. O SQL não muda.

## 1. Inventário (código e banco em `51829ac`, cadeia 01–84)

| Objeto | Estado antes | Risco |
|---|---|---|
| `chatwoot_contacts`, `chatwoot_conversations`, `chatwoot_messages` | PK global `id int` = id do Chatwoot; FKs legadas `contact_id`/`conversation_id` por esse id; índices únicos `uq_chatwoot_*_org_id (organizacao_id, id)` | duas instalações numeram a partir de 1 |
| Gatilhos da migration 27 | preenchem a organização quando vem nula; só a conversa e a mensagem conferem a organização do pai | nada impede o `upsert` de B no id 5 de **mover** a linha 5 de A (`service_role` ignora RLS) |
| `chatwootWebhookPersistence.ts` | `upsert` pela PK com `organizacao_id` e `conexao_id` verificados | — |
| `api/chatwoot/sync/route.ts` | `upsert` pela PK com a organização, **sem `conexao_id`** | linhas sem prova de instalação |
| `api/chatwoot/send`, `status`, `chatwootWebhookService`, `espelhoDaMensageria` | leem/atualizam por `id` + `organizacao_id` | migram no MSG-003A/003B; intocados aqui |
| `chatwoot_inboxes` | UUID próprio; único por `(organizacao_id, inbox_id)` e `(conexao_id, inbox_id)`; validado pelo PRE-008 | usado só como prova de conexão |
| `inbox_eventos_chatwoot`, outbox, retenção (51), titular (50) | não guardam id de espelho como chave | nenhum |
| Navegador | só `SELECT` nos espelhos (RLS por membership) | conferido pela autoverificação |

> Atualização do MSG-003A: webhook, sync e o status do webhook já gravam e
> localizam pelo UUID local; ver `docs/operations/msg-003a-runbook.md`.

Diferença com a documentação histórica: o plano cita a `main e71354e`; o código
atual já grava `conexao_id` no webhook e já tem o mapeamento de inbox validado
(PRE-008). A lacuna real era o sync e a falta de imutabilidade da organização.

## 2. Modelo

- `id_local uuid` nas três tabelas: default `gen_random_uuid()`, `NOT NULL`,
  único, imutável.
- `id_externo text = id::text` (CHECK até o MSG-004), único por
  `(organizacao_id, conexao_id, id_externo)`.
- `contato_id_local` e `conversa_id_local`, com FK composta
  `(organizacao_id, *_id_local)` → pai `(organizacao_id, id_local)`,
  `on delete cascade` (como as FKs legadas).
- Gatilho `trg_vincula_identidade_local_chatwoot` (dispara depois do gatilho
  legado de organização): preenche o modelo a partir da escrita legada, infere a
  conexão só por prova (inbox da organização → contato; mensagem ← conversa;
  contato ← conexão única das suas conversas), recusa troca de instalação
  (`23514`), conexão de outra organização ou provedor (`23503`) e vínculo novo
  com pai de outra conexão (`23503`). Completar identidade preserva `updated_at`.
- Organização imutável nas três tabelas (função da migration 84).
- `backfill_identidade_local_chatwoot(lote)`: lotes idempotentes, advisory lock,
  `skip locked`, só `service_role`. A migration o roda até o fim.
- `chatwoot_identidade_em_quarentena`: view derivada, só `service_role`, motivos
  `sem_organizacao`, `conexao_nao_comprovada`, `contato_nao_vinculado`,
  `conversa_nao_vinculada`, `conexao_divergente_do_*`.

## 3. Ordem e matriz aplicação × banco

Bancos: **S87** = cadeia até a 84 (PRE-008); **S88** = S87 + 85.
Código: **base** = `51829ac`; **MSG-002** = esta branch (o sync passa a mandar
`conexao_id`).

| Código \ Banco | S87 | S88 |
|---|---|---|
| base | estado atual | **compatível**: a escrita legada do webhook e do sync (sem conexão) é exatamente a dos itens 1–4 e 21–24 do pgTAP final; a colisão que antes movia a linha agora falha com `23514` |
| MSG-002 | **compatível**: provado no laboratório com o ledger cortado na ordem 87 — os três `upsert` do sync com `conexao_id` gravam (a coluna existe desde a 27) | **compatível**: `test:db` inteiro e `sync.test.ts` |

Ordem recomendada: mesclar o código (inofensivo no S87) → aplicar a 85 → rodar
um sync manual por organização com Chatwoot (resolve contatos que estavam em
quarentena por falta de conexão). As duas ordens funcionam.

## 4. GO/NO-GO antes de aplicar (somente leitura, no alvo)

```sql
-- 1. volume (decide se a migration única basta; ver risco R1)
select (select count(*) from public.chatwoot_contacts) contatos,
       (select count(*) from public.chatwoot_conversations) conversas,
       (select count(*) from public.chatwoot_messages) mensagens;
-- 2. preflight: precisa ser 0, senão a migration aborta sem mudar nada
select count(*) from (select organizacao_id, conexao_id from public.chatwoot_contacts
                      union all select organizacao_id, conexao_id from public.chatwoot_conversations
                      union all select organizacao_id, conexao_id from public.chatwoot_messages) e
  left join public.conexoes_integracao c on c.id = e.conexao_id
 where e.conexao_id is not null
   and (c.id is null or c.provedor <> 'chatwoot' or c.organizacao_id is distinct from e.organizacao_id);
```

GO: ledger do alvo em S87, preflight = 0, volume abaixo de ~1 milhão de linhas
(no laboratório, 3006 linhas levaram 473 ms com os gatilhos legados).

## 5. Aplicação

```bash
npm run db:remoto:status  -- --url "<connection>" --previa --ate-arquivo 85_identidade_local_chatwoot.sql
npm run db:remoto:aplicar -- --url "<connection>" --confirmar --ate-arquivo 85_identidade_local_chatwoot.sql
```

Uma transação; `lock_timeout = 5s`. Locks: `ACCESS EXCLUSIVE` nas três tabelas
durante o `ALTER TABLE` e até o commit (o webhook espera ou falha e o Chatwoot
reentrega). A migration emite `NOTICE` com a quarentena por tabela e motivo.

## 6. Validação depois de aplicar

```sql
select count(*) filter (where id_local is null) from public.chatwoot_messages;          -- 0
select tabela, motivo, count(*) from public.chatwoot_identidade_em_quarentena group by 1, 2;
select sum(atualizadas) from public.backfill_identidade_local_chatwoot(1000);           -- 0 (idempotente)
```

A quarentena é esperada para linhas criadas pelo sync antigo cuja conversa está
num inbox sem mapeamento. Ela não bloqueia leitura nem escrita legada.

## 7. Recuperação (forward-only)

- Migration falhou: a transação desfaz tudo; corrigir a causa (preflight) e
  reaplicar.
- Escrita legada recusada com `23514`/`23503` depois da 85: é uma colisão de id
  entre organizações ou instalações. Antes ela sobrescrevia dados de outro
  tenant. Não se remove o gatilho. Pausar a conexão que colide e aguardar o
  MSG-003A/004.
- Backfill interrompido: rodar `backfill_identidade_local_chatwoot` de novo;
  cada lote é atômico e a retomada é por estado, não por cursor.
- Nunca restaurar grant amplo, apagar o ledger nem editar a migration aplicada.

## 8. Evidência

- `supabase/tests/final/identidade_local_chatwoot.test.sql` (50): colisão,
  conexão errada, vínculo forjado, replay, sync sem conexão, falha no meio do
  lote, retomada, RLS, contraprovas e a simulação pós-contração.
- `supabase/tests/database/identidade_local_chatwoot_backfill.test.sql` (16):
  a migration sobre dados existentes, aborto do preflight com reversão.
- `scripts/database-concurrency-identidade-chatwoot.mjs`: três corridas com
  bloqueio observado.
- `src/app/api/chatwoot/sync/sync.test.ts`: o sync grava a conexão do adapter.

## 9. Para o MSG-004

A simulação (itens 37–44 do pgTAP final) mostra o que precisa sair para duas
instalações coexistirem: a PK `id` e as FKs legadas por id, **os índices
`uq_chatwoot_*_org_id (organizacao_id, id)`** e os gatilhos da migration 27 que
procuram o pai só pelo id. O CHECK `id_externo = id::text` também sai.

> Atualização do MSG-004: feito, exceto o CHECK, mantido como coerência do eco
> `id`; o inventário completo (inbox, eventos, retenção, baseline) está em
> `docs/operations/msg-004-runbook.md`.
