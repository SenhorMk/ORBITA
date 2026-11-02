-- contracao_chaves_chatwoot.test.sql
-- MSG-004 aplicado sobre o snapshot expandido (migration 85 com dados): a
-- instalação existente, com linhas do sync antigo em quarentena, legal hold
-- pelo id remoto e eventos no inbox. O teste monta só o que as duas migrations
-- leem, aplica a 85 sobre os dados legados e depois a contração, duas vezes: a
-- primeira aborta no preflight e não deixa rastro; a segunda conclui.
--
-- Prova: relação legada sem identidade local impede a contração; depois dela
-- nenhuma linha, conteúdo ou `updated_at` muda; o hold numérico passa a
-- proteger o UUID certo; a quarentena continua legível e fail-closed; o
-- backfill segue idempotente; ids repetidos passam a coexistir.
--
-- REINTRODUZIR O DEFEITO (medido):
--   - sem o preflight: 1 falha (a FK legada sai com a conversa 81 só ligada
--     pelo id remoto, e a cascata de exclusão do contato 9 não a alcança);
--   - sem traduzir o hold: 9 falha (o contato 5 perde a proteção);
--   - backfill selecionando por `id` em vez de `id_local`: 13 e 16 falham (toca e
--     reinicia o relógio de retenção do contato 7 de B).

begin;

create table public.organizacoes (id uuid primary key);
create table public.membros_organizacao (organizacao_id uuid, user_id uuid, papel text, created_at timestamptz default now());
create table public.conexoes_integracao (
    id uuid primary key,
    organizacao_id uuid not null references public.organizacoes(id),
    provedor text not null
);
create table public.chatwoot_inboxes (
    id uuid primary key default gen_random_uuid(),
    organizacao_id uuid references public.organizacoes(id),
    conexao_id uuid references public.conexoes_integracao(id) on delete set null,
    inbox_id int not null
);
create unique index uq_chatwoot_inboxes_org_inbox on public.chatwoot_inboxes(organizacao_id, inbox_id);
create table public.chatwoot_contacts (
    id int primary key,
    user_id uuid,
    organizacao_id uuid references public.organizacoes(id) on delete cascade,
    conexao_id uuid references public.conexoes_integracao(id) on delete set null,
    name text not null,
    email text,
    phone_number text,
    phone_normalizado text,
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create table public.chatwoot_conversations (
    id int primary key,
    user_id uuid,
    organizacao_id uuid references public.organizacoes(id) on delete cascade,
    conexao_id uuid references public.conexoes_integracao(id) on delete set null,
    display_id int,
    contact_id int not null references public.chatwoot_contacts(id) on delete cascade,
    status text not null default 'open',
    inbox_id int,
    channel text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create table public.chatwoot_messages (
    id int primary key,
    user_id uuid,
    organizacao_id uuid references public.organizacoes(id) on delete cascade,
    conexao_id uuid references public.conexoes_integracao(id) on delete set null,
    conversation_id int not null references public.chatwoot_conversations(id) on delete cascade,
    content text,
    message_type text,
    sender_name text,
    sender_id int,
    sender_type text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- Migration 27/55: os únicos legados por organização + id.
create unique index uq_chatwoot_contacts_org_id on public.chatwoot_contacts(organizacao_id, id);
create unique index uq_chatwoot_conversations_org_id on public.chatwoot_conversations(organizacao_id, id);
create unique index uq_chatwoot_messages_org_id on public.chatwoot_messages(organizacao_id, id);
-- Migration 29: inbox de eventos, dedup por organização + chave.
create table public.inbox_eventos_chatwoot (
    id uuid primary key default gen_random_uuid(),
    organizacao_id uuid not null references public.organizacoes(id),
    conexao_id uuid references public.conexoes_integracao(id),
    user_id uuid,
    inbox_id bigint,
    idempotency_key text not null,
    event_type text not null,
    payload jsonb not null default '{}',
    status text not null,
    attempts int not null default 0,
    response_body jsonb
);
create unique index uq_inbox_eventos_chatwoot_org_key on public.inbox_eventos_chatwoot(organizacao_id, idempotency_key);
-- Migration 51: só o que a contração lê.
create table public.retention_policy_registry (categoria text, versao int, tabela_alvo text);
create table public.retention_legal_holds (
    id uuid primary key default gen_random_uuid(),
    organizacao_id uuid not null,
    categoria text not null,
    entidade_id text not null,
    motivo text not null,
    liberado_em timestamptz
);
-- Grants como na cadeia: o navegador só lê os espelhos.
revoke all on public.chatwoot_contacts, public.chatwoot_conversations, public.chatwoot_messages,
              public.chatwoot_inboxes, public.inbox_eventos_chatwoot from anon, authenticated;
grant select on public.chatwoot_contacts, public.chatwoot_conversations, public.chatwoot_messages to authenticated;

-- Migrations 17, 27 e 84, na forma em que a contração as encontra.
create function public.fn_set_updated_at() returns trigger language plpgsql set search_path = '' as $f$
begin
    new.updated_at = now();
    return new;
end $f$;
create trigger tg_chatwoot_contacts_updated_at before update on public.chatwoot_contacts
    for each row execute function public.fn_set_updated_at();
create trigger tg_chatwoot_conversations_updated_at before update on public.chatwoot_conversations
    for each row execute function public.fn_set_updated_at();
create trigger tg_chatwoot_messages_updated_at before update on public.chatwoot_messages
    for each row execute function public.fn_set_updated_at();
create function public.fn_sync_chatwoot_conversations_organizacao() returns trigger language plpgsql as $f$
begin
    return new;
end $f$;
create function public.fn_sync_chatwoot_messages_organizacao() returns trigger language plpgsql as $f$
begin
    return new;
end $f$;
create trigger trg_sync_chatwoot_conversations_organizacao before insert or update on public.chatwoot_conversations
    for each row execute function public.fn_sync_chatwoot_conversations_organizacao();
create trigger trg_sync_chatwoot_messages_organizacao before insert or update on public.chatwoot_messages
    for each row execute function public.fn_sync_chatwoot_messages_organizacao();
create function public.fn_organizacao_da_integracao_imutavel() returns trigger language plpgsql
security invoker set search_path = '' as $f$
begin
    if old.organizacao_id is not null and new.organizacao_id is distinct from old.organizacao_id then
        raise exception 'A organizacao de %.% nao muda depois de definida.', tg_table_schema, tg_table_name
            using errcode = '23514';
    end if;
    return new;
end $f$;

-- ----------------------------------------------------------------------------
-- A instalação existente. A: c1 (Chatwoot) e c2 (Bling); inbox 1 → c1.
-- B: duas instalações, c3 (inbox 1) e c4.
-- ----------------------------------------------------------------------------
insert into public.organizacoes values ('e4100000-0000-4000-8000-00000000000a'), ('e4100000-0000-4000-8000-00000000000b');
insert into public.conexoes_integracao values
    ('e4100000-0000-4000-8000-0000000000c1', 'e4100000-0000-4000-8000-00000000000a', 'chatwoot'),
    ('e4100000-0000-4000-8000-0000000000c2', 'e4100000-0000-4000-8000-00000000000a', 'bling'),
    ('e4100000-0000-4000-8000-0000000000c3', 'e4100000-0000-4000-8000-00000000000b', 'chatwoot'),
    ('e4100000-0000-4000-8000-0000000000c4', 'e4100000-0000-4000-8000-00000000000b', 'chatwoot');
insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id) values
    ('e4100000-0000-4000-8000-00000000000a', 'e4100000-0000-4000-8000-0000000000c1', 1),
    ('e4100000-0000-4000-8000-00000000000b', 'e4100000-0000-4000-8000-0000000000c3', 1);

-- 5: webhook. 7: sync num inbox sem mapeamento (fica em quarentena). 8: B/c3.
-- 9: B/c4, mas a conversa 81 (c3) aponta para ele (vínculo local impossível).
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name, updated_at) values
    (5, 'e4100000-0000-4000-8000-00000000000a', 'e4100000-0000-4000-8000-0000000000c1', 'Webhook A', '2026-01-05 00:00+00'),
    (7, 'e4100000-0000-4000-8000-00000000000a', null, 'Sem prova', '2026-01-07 00:00+00'),
    (8, 'e4100000-0000-4000-8000-00000000000b', 'e4100000-0000-4000-8000-0000000000c3', 'B c3', '2026-01-08 00:00+00'),
    (9, 'e4100000-0000-4000-8000-00000000000b', 'e4100000-0000-4000-8000-0000000000c4', 'B c4', '2026-01-09 00:00+00');
insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, inbox_id, updated_at) values
    (50, 'e4100000-0000-4000-8000-00000000000a', 'e4100000-0000-4000-8000-0000000000c1', 5, 1, '2026-02-05 00:00+00'),
    (70, 'e4100000-0000-4000-8000-00000000000a', null, 7, 99, '2026-02-07 00:00+00'),
    (80, 'e4100000-0000-4000-8000-00000000000b', 'e4100000-0000-4000-8000-0000000000c3', 8, 1, '2026-02-08 00:00+00'),
    (81, 'e4100000-0000-4000-8000-00000000000b', 'e4100000-0000-4000-8000-0000000000c3', 9, 1, '2026-02-09 00:00+00');
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content, updated_at) values
    (500, 'e4100000-0000-4000-8000-00000000000a', 'e4100000-0000-4000-8000-0000000000c1', 50, 'webhook', '2026-03-05 00:00+00'),
    (700, 'e4100000-0000-4000-8000-00000000000a', null, 70, 'sem prova', '2026-03-07 00:00+00'),
    (800, 'e4100000-0000-4000-8000-00000000000b', 'e4100000-0000-4000-8000-0000000000c3', 80, 'b', '2026-03-08 00:00+00');
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content, updated_at)
select g, 'e4100000-0000-4000-8000-00000000000a', 'e4100000-0000-4000-8000-0000000000c1', 50, 'lote ' || g, '2026-04-01 00:00+00'
  from generate_series(10000, 11499) g;

create function pg_temp.aplicar_migration_85() returns void language plpgsql as $migracao$
begin
\ir ../../../database/85_identidade_local_chatwoot.sql
end
$migracao$;
select pg_temp.aplicar_migration_85();

-- O snapshot expandido: hold pelo id remoto (um vivo, um de linha já apagada)
-- e um evento já processado no inbox.
insert into public.retention_policy_registry values ('chatwoot_contato_inativo', 1, 'chatwoot_contacts');
insert into public.retention_legal_holds (organizacao_id, categoria, entidade_id, motivo) values
    ('e4100000-0000-4000-8000-00000000000a', 'chatwoot_contato_inativo', '5', 'processo'),
    ('e4100000-0000-4000-8000-00000000000a', 'chatwoot_contato_inativo', '42', 'linha já apagada');
insert into public.inbox_eventos_chatwoot (organizacao_id, conexao_id, idempotency_key, event_type, status)
values ('e4100000-0000-4000-8000-00000000000a', 'e4100000-0000-4000-8000-0000000000c1',
        'event_message_created_msg_500_conv_50', 'message_created', 'processed');

create temp table retrato as
select 'c' as t, row(id_local, id_externo, organizacao_id, conexao_id, name, updated_at)::text as r from public.chatwoot_contacts
union all
select 'v', row(id_local, id_externo, organizacao_id, conexao_id, contato_id_local, status, updated_at)::text
  from public.chatwoot_conversations where id <> 81
union all
select 'm', row(id_local, id_externo, organizacao_id, conexao_id, conversa_id_local, content, updated_at)::text
  from public.chatwoot_messages;

create function pg_temp.aplicar_contracao() returns void language plpgsql as $migracao$
begin
\ir ../../../database/87_contrair_chaves_globais_chatwoot.sql
end
$migracao$;

select plan(17);

-- ----------------------------------------------------------------------------
-- 1-2. A conversa 81 só está ligada ao contato pelo id remoto (a 85 a deixou em
-- quarentena): a contração aborta e nada muda.
-- ----------------------------------------------------------------------------
select throws_like('select pg_temp.aplicar_contracao()',
                   'MSG-004: relacao legada sem identidade local (conversas sem contato local=1,%',
                   '1. preflight aborta com conversa sem vínculo local');
select col_is_pk('public', 'chatwoot_contacts', 'id', '2. a contração abortada deixou a PK legada');

-- A decisão operacional do runbook: a conversa 81 é de outra instalação e é
-- reimportada pelo sync da conexão certa; aqui, apagada.
delete from public.chatwoot_conversations where id = 81;

-- ----------------------------------------------------------------------------
-- 3-16. Resolvida a quarentena de vínculo, a contração conclui.
-- ----------------------------------------------------------------------------
select lives_ok('select pg_temp.aplicar_contracao()', '3. a contração conclui');
select col_is_pk('public', 'chatwoot_messages', 'id_local', '4. PK pelo UUID local');
select hasnt_index('public', 'chatwoot_contacts', 'uq_chatwoot_contacts_org_id', '5. sem o único por organização + id');
select set_eq(
    $$select 'c', row(id_local, id_externo, organizacao_id, conexao_id, name, updated_at)::text from public.chatwoot_contacts
      union all
      select 'v', row(id_local, id_externo, organizacao_id, conexao_id, contato_id_local, status, updated_at)::text
        from public.chatwoot_conversations
      union all
      select 'm', row(id_local, id_externo, organizacao_id, conexao_id, conversa_id_local, content, updated_at)::text
        from public.chatwoot_messages$$,
    $$select t, r from retrato$$,
    '6. mesmas linhas, UUIDs, vínculos, conteúdo e updated_at');
select is((select count(*)::int from public.chatwoot_messages where conversa_id_local is not null), 1503,
          '7. as 1503 mensagens continuam ligadas à sua conversa');
select set_eq($$select tabela, id_externo from public.chatwoot_identidade_em_quarentena$$,
              $$values ('chatwoot_contacts'::text, '7'::text), ('chatwoot_conversations', '70'), ('chatwoot_messages', '700')$$,
              '8. a quarentena de conexão continua legível, sem palpite');
select is((select entidade_id from public.retention_legal_holds where motivo = 'processo'),
          (select id_local::text from public.chatwoot_contacts where id_externo = '5'),
          '9. o hold numérico do contato 5 passa a proteger o seu UUID');
select is((select entidade_id from public.retention_legal_holds where motivo = 'linha já apagada'), '42',
          '10. o hold de linha inexistente fica como estava');
select is((select is_duplicate from public.registrar_evento_inbox_chatwoot(
              'e4100000-0000-4000-8000-00000000000a', 'e4100000-0000-4000-8000-0000000000c1', null, 1,
              'event_message_created_msg_500_conv_50', 'message_created', '{}'::jsonb)), true,
          '11. o evento já processado continua duplicata na sua instalação');
select results_eq($$select tabela, atualizadas, pendentes from public.backfill_identidade_local_chatwoot(1000)$$,
                  $$values ('chatwoot_contacts'::text, 0, 1::bigint), ('chatwoot_conversations', 0, 1), ('chatwoot_messages', 0, 1)$$,
                  '12. o backfill é idempotente e conta a quarentena pendente');
-- A prova chega (inbox 99 mapeado em c1): o backfill retoma sem trocar updated_at.
-- B, já contraído, tem o seu próprio contato 7: o backfill não pode tocá-lo.
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name, updated_at)
values (7, 'e4100000-0000-4000-8000-00000000000b', 'e4100000-0000-4000-8000-0000000000c3', 'B c3 com o id 7', '2026-01-10 00:00+00');
insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id)
values ('e4100000-0000-4000-8000-00000000000a', 'e4100000-0000-4000-8000-0000000000c1', 99);
select is((select sum(atualizadas)::int from public.backfill_identidade_local_chatwoot(1000)), 3,
          '13. contato 7, conversa 70 e mensagem 700 ganham a conexão provada pelo inbox');
select is((select sum(atualizadas)::int from public.backfill_identidade_local_chatwoot(1000)), 0,
          '14. e a volta seguinte não tem o que fazer');
select is((select updated_at from public.chatwoot_contacts where organizacao_id = 'e4100000-0000-4000-8000-00000000000a' and id_externo = '7'),
          '2026-01-07 00:00+00'::timestamptz,
          '15. sair da quarentena não troca o updated_at');
select is((select updated_at from public.chatwoot_contacts where organizacao_id = 'e4100000-0000-4000-8000-00000000000b' and id_externo = '7'),
          '2026-01-10 00:00+00'::timestamptz, '16. o contato 7 de B, com o mesmo id, não foi tocado pelo backfill de A');
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
values (8, 'e4100000-0000-4000-8000-00000000000b', 'e4100000-0000-4000-8000-0000000000c4', 'B c4 com o id 8');
select is((select count(*)::int from public.chatwoot_contacts where id_externo = '8'), 2,
          '17. o contato 8 de c4 coexiste com o 8 de c3');

select * from finish();
rollback;
