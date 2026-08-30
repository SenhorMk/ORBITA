-- 55_upsert_conflito_inferivel.sql
-- Forward-only.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO
-- ---------------------------------------------------------------------------
-- Todo upsert com escopo de organizacao falhava. Sempre. Desde a migration 22.
--
--   supabaseServer.from('clientes').upsert(payload, { onConflict: 'organizacao_id, bling_id' })
--
-- O PostgREST traduz isso para `ON CONFLICT (organizacao_id, bling_id) DO
-- UPDATE ...` — sem clausula WHERE, porque a API nao tem como expressar uma.
-- Os indices unicos correspondentes, porem, foram criados PARCIAIS:
--
--   create unique index uq_clientes_org_bling on public.clientes(organizacao_id, bling_id)
--       where organizacao_id is not null and bling_id is not null;
--
-- O PostgreSQL so infere um indice parcial quando a propria instrucao repete o
-- predicado do indice. Sem o WHERE, a inferencia nao encontra nada e o comando
-- morre com:
--
--   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
--          specification
--
-- Reproduzido contra o banco real em 2026-08-30, em transacao revertida.
--
-- ---------------------------------------------------------------------------
-- POR QUE DEMOROU A APARECER
-- ---------------------------------------------------------------------------
-- Cinco camadas transformavam esse 42P10 em silencio, e a ultima o tornava
-- permanente. O ticket 12c parou de engolir a falha, e ela finalmente
-- apareceu na tela — mas ilegivel: `Primeira falha: [object Object]`, porque
-- o PostgrestError nao e um `Error` e `String()` dele nao diz nada. O helper
-- `src/lib/erroLegivel.ts`, deste mesmo ticket, fecha essa metade.
--
-- ---------------------------------------------------------------------------
-- A CORRECAO
-- ---------------------------------------------------------------------------
-- Recriar os indices sem o predicado. A troca e semanticamente NEUTRA nos
-- casos abaixo, por dois motivos independentes:
--
--   1. `organizacao_id` e NOT NULL em todas essas tabelas desde as migrations
--      42/43 — o predicado ja era vacuamente verdadeiro para toda linha.
--   2. Onde a segunda coluna ainda aceita NULL (bling_id em documentos_fiscais,
--      contas_financeiras, categorias_financeiras, fornecedores,
--      titulos_financeiros), o padrao NULLS DISTINCT do PostgreSQL faz o indice
--      total ignorar essas linhas exatamente como o predicado fazia.
--
-- Ficam de fora, deliberadamente, os indices parciais cujo predicado filtra
-- VALOR e nao nulidade — `uq_sync_jobs_org_active` (status em execucao),
-- `uq_retention_hold_ativo` (hold nao liberado) e
-- `uq_retention_policy_categoria_aprovada`. Esses sao parciais de proposito,
-- nao sao alvo de ON CONFLICT, e torna-los totais mudaria a regra de negocio.

-- ---------------------------------------------------------------------------
-- Catalogo comercial e de estoque (migrations 22 e 23).
-- ---------------------------------------------------------------------------
drop index if exists public.uq_produtos_org_bling;
create unique index if not exists uq_produtos_org_bling
    on public.produtos(organizacao_id, bling_id);

drop index if exists public.uq_categorias_org_bling;
create unique index if not exists uq_categorias_org_bling
    on public.categorias(organizacao_id, bling_id);

drop index if exists public.uq_clientes_org_bling;
create unique index if not exists uq_clientes_org_bling
    on public.clientes(organizacao_id, bling_id);

drop index if exists public.uq_pedidos_org_bling;
create unique index if not exists uq_pedidos_org_bling
    on public.pedidos(organizacao_id, bling_id);

drop index if exists public.uq_documentos_fiscais_org_bling;
create unique index if not exists uq_documentos_fiscais_org_bling
    on public.documentos_fiscais(organizacao_id, bling_id);

-- ---------------------------------------------------------------------------
-- Financeiro (migration 24).
-- ---------------------------------------------------------------------------
drop index if exists public.uq_contas_financeiras_org_bling;
create unique index if not exists uq_contas_financeiras_org_bling
    on public.contas_financeiras(organizacao_id, bling_id);

drop index if exists public.uq_categorias_financeiras_org_bling;
create unique index if not exists uq_categorias_financeiras_org_bling
    on public.categorias_financeiras(organizacao_id, bling_id);

drop index if exists public.uq_fornecedores_org_bling;
create unique index if not exists uq_fornecedores_org_bling
    on public.fornecedores(organizacao_id, bling_id);

drop index if exists public.uq_titulos_financeiros_org_bling;
create unique index if not exists uq_titulos_financeiros_org_bling
    on public.titulos_financeiros(organizacao_id, bling_id);

-- ---------------------------------------------------------------------------
-- Marcador de progresso da sincronizacao (migration 32).
--
-- `touchSyncState` roda ao fim de CADA etapa com
-- `onConflict: 'organizacao_id, entidade'`. Mesmo com os indices acima
-- corrigidos, a etapa ainda morreria aqui, na ultima linha.
-- ---------------------------------------------------------------------------
drop index if exists public.uq_sync_state_org_entidade;
create unique index if not exists uq_sync_state_org_entidade
    on public.sync_state(organizacao_id, entidade);

-- ---------------------------------------------------------------------------
-- Chatwoot (migrations 27 e 29).
-- ---------------------------------------------------------------------------
drop index if exists public.uq_chatwoot_inboxes_org_inbox;
create unique index if not exists uq_chatwoot_inboxes_org_inbox
    on public.chatwoot_inboxes(organizacao_id, inbox_id);

drop index if exists public.uq_chatwoot_inboxes_conexao_inbox;
create unique index if not exists uq_chatwoot_inboxes_conexao_inbox
    on public.chatwoot_inboxes(conexao_id, inbox_id);

drop index if exists public.uq_chatwoot_contacts_org_id;
create unique index if not exists uq_chatwoot_contacts_org_id
    on public.chatwoot_contacts(organizacao_id, id);

drop index if exists public.uq_chatwoot_conversations_org_id;
create unique index if not exists uq_chatwoot_conversations_org_id
    on public.chatwoot_conversations(organizacao_id, id);

drop index if exists public.uq_chatwoot_messages_org_id;
create unique index if not exists uq_chatwoot_messages_org_id
    on public.chatwoot_messages(organizacao_id, id);
