-- identidade_local_chatwoot_backfill.test.sql
-- MSG-002, migration 85 aplicada sobre espelhos legados que já têm dados: a
-- instalação existente. O teste monta só o que a migration lê (as tabelas como
-- estão depois da 84, sem os gatilhos legados que não interferem) e a aplica
-- por inteiro, duas vezes: a primeira aborta no preflight e não deixa rastro; a
-- segunda conclui.
--
-- Prova: UUID em toda linha, inclusive em vários lotes; nenhum conteúdo,
-- organização ou `updated_at` legado muda; conexão só por prova; o que não tem
-- prova fica em quarentena e legível; a leitura antiga pelo id continua; o
-- backfill é idempotente e retoma quando a prova aparece.
--
-- REINTRODUZIR O DEFEITO (medido):
--   - sem preservar `updated_at` no gatilho: a autoverificação da própria
--     migration aborta ("o legado mudou"); 3 falha e o arquivo para;
--   - inferir conexão sem prova única (a primeira conexão Chatwoot da
--     organização): 10 e 14 falham;
--   - sem o preflight: 1-3 falham (a migration aceita a linha corrompida).

begin;

create table public.organizacoes (id uuid primary key);
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
-- Grants como na cadeia: o navegador só lê os espelhos.
revoke all on public.chatwoot_contacts, public.chatwoot_conversations, public.chatwoot_messages from anon, authenticated;
grant select on public.chatwoot_contacts, public.chatwoot_conversations, public.chatwoot_messages to authenticated;

-- Migration 17 (updated_at) e migration 84 (organização imutável), como estão.
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
-- A instalação existente. A: conexão c1, inbox 1 → c1. B: duas instalações,
-- c3 (inbox 1) e c4.
-- ----------------------------------------------------------------------------
insert into public.organizacoes values ('e3000000-0000-4000-8000-00000000000a'), ('e3000000-0000-4000-8000-00000000000b');
insert into public.conexoes_integracao values
    ('e3000000-0000-4000-8000-0000000000c1', 'e3000000-0000-4000-8000-00000000000a', 'chatwoot'),
    ('e3000000-0000-4000-8000-0000000000c2', 'e3000000-0000-4000-8000-00000000000a', 'bling'),
    ('e3000000-0000-4000-8000-0000000000c3', 'e3000000-0000-4000-8000-00000000000b', 'chatwoot'),
    ('e3000000-0000-4000-8000-0000000000c4', 'e3000000-0000-4000-8000-00000000000b', 'chatwoot');
insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id) values
    ('e3000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-0000000000c1', 1),
    ('e3000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-0000000000c3', 1);

-- 5: webhook (com conexão). 6: sync, conversa no inbox 1. 7: sync, conversa num
-- inbox sem mapeamento. 8: B/c3. 9: B/c4, mas a conversa 80 (c3) aponta para ele.
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name, updated_at) values
    (5, 'e3000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-0000000000c1', 'Webhook A', '2026-01-05 00:00+00'),
    (6, 'e3000000-0000-4000-8000-00000000000a', null, 'Sync A', '2026-01-06 00:00+00'),
    (7, 'e3000000-0000-4000-8000-00000000000a', null, 'Sem prova', '2026-01-07 00:00+00'),
    (8, 'e3000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-0000000000c3', 'B c3', '2026-01-08 00:00+00'),
    (9, 'e3000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-0000000000c4', 'B c4', '2026-01-09 00:00+00');
insert into public.chatwoot_conversations (id, organizacao_id, conexao_id, contact_id, inbox_id, updated_at) values
    (50, 'e3000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-0000000000c1', 5, 1, '2026-02-05 00:00+00'),
    (60, 'e3000000-0000-4000-8000-00000000000a', null, 6, 1, '2026-02-06 00:00+00'),
    (70, 'e3000000-0000-4000-8000-00000000000a', null, 7, 99, '2026-02-07 00:00+00'),
    (80, 'e3000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-0000000000c3', 9, 1, '2026-02-08 00:00+00');
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content, updated_at) values
    (500, 'e3000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-0000000000c1', 50, 'webhook', '2026-03-05 00:00+00'),
    (600, 'e3000000-0000-4000-8000-00000000000a', null, 60, 'sync', '2026-03-06 00:00+00'),
    (700, 'e3000000-0000-4000-8000-00000000000a', null, 70, 'sem prova', '2026-03-07 00:00+00'),
    (800, 'e3000000-0000-4000-8000-00000000000b', null, 80, 'b', '2026-03-08 00:00+00');
-- Volume para o backfill dar mais de uma volta de 1000.
insert into public.chatwoot_messages (id, organizacao_id, conexao_id, conversation_id, content, updated_at)
select g, 'e3000000-0000-4000-8000-00000000000a', null, 50, 'lote ' || g, '2026-04-01 00:00+00'
  from generate_series(10000, 12499) g;

create temp table legado as
select 'c' as t, row(id, user_id, organizacao_id, name, email, phone_number, phone_normalizado, avatar_url, created_at, updated_at)::text as r
  from public.chatwoot_contacts
union all
select 'v', row(id, user_id, organizacao_id, display_id, contact_id, status, inbox_id, channel, created_at, updated_at)::text
  from public.chatwoot_conversations
union all
select 'm', row(id, user_id, organizacao_id, conversation_id, content, message_type, sender_name, sender_id, sender_type, created_at, updated_at)::text
  from public.chatwoot_messages;

-- A migration, inteira, como corpo de uma função: a mesma transação pode vê-la
-- abortar e depois concluir.
create function pg_temp.aplicar_migration_85() returns void language plpgsql as $migracao$
begin
\ir ../../../database/85_identidade_local_chatwoot.sql
end
$migracao$;

select plan(16);

-- ----------------------------------------------------------------------------
-- 1-2. Uma linha corrompida (contato de A na conexão de B) aborta a migration
-- no preflight, e nada fica para trás.
-- ----------------------------------------------------------------------------
insert into public.chatwoot_contacts (id, organizacao_id, conexao_id, name)
values (4, 'e3000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-0000000000c3', 'Corrompido');
select throws_like('select pg_temp.aplicar_migration_85()', 'MSG-002: 1 linha(s) de espelho Chatwoot apontam para conexao%',
                   '1. preflight aborta com linha de espelho na conexão de outra organização');
select hasnt_column('public', 'chatwoot_messages', 'id_local', '2. a migration abortada não deixou coluna nem gatilho');
delete from public.chatwoot_contacts where id = 4;

-- ----------------------------------------------------------------------------
-- 3-16. Corrigida a linha, a migration conclui sobre os dados existentes.
-- ----------------------------------------------------------------------------
select lives_ok('select pg_temp.aplicar_migration_85()', '3. a migration conclui depois da correção');

select is((select count(*)::int from (select id_local from public.chatwoot_contacts
                                      union all select id_local from public.chatwoot_conversations
                                      union all select id_local from public.chatwoot_messages) u
            where id_local is not null), 2513, '4. todas as 2513 linhas têm UUID local');
select is((select count(distinct id_local)::int from (select id_local from public.chatwoot_contacts
                                                       union all select id_local from public.chatwoot_conversations
                                                       union all select id_local from public.chatwoot_messages) u), 2513,
          '5. e nenhum UUID se repete');
select set_eq(
    $$select 'c', row(id, user_id, organizacao_id, name, email, phone_number, phone_normalizado, avatar_url, created_at, updated_at)::text
        from public.chatwoot_contacts
      union all
      select 'v', row(id, user_id, organizacao_id, display_id, contact_id, status, inbox_id, channel, created_at, updated_at)::text
        from public.chatwoot_conversations
      union all
      select 'm', row(id, user_id, organizacao_id, conversation_id, content, message_type, sender_name, sender_id, sender_type, created_at, updated_at)::text
        from public.chatwoot_messages$$,
    $$select t, r from legado$$,
    '6. mesmas linhas, mesmo conteúdo, mesma organização');
select is((select updated_at from public.chatwoot_messages where id = 12499), '2026-04-01 00:00+00'::timestamptz,
          '7. o backfill não reiniciou o updated_at (retenção e ordem da caixa intactas)');
select is((select content from public.chatwoot_messages where id = 600), 'sync', '8. a leitura antiga pelo id continua');
select results_eq(
    $$select (select conexao_id from public.chatwoot_contacts where id = 6),
             (select conexao_id from public.chatwoot_conversations where id = 60),
             (select conexao_id from public.chatwoot_messages where id = 600)$$,
    $$values ('e3000000-0000-4000-8000-0000000000c1'::uuid, 'e3000000-0000-4000-8000-0000000000c1'::uuid,
              'e3000000-0000-4000-8000-0000000000c1'::uuid)$$,
    '9. a linha do sync herda a conexão provada pelo inbox');
select set_eq(
    $$select tabela, id_externo, motivo from public.chatwoot_identidade_em_quarentena$$,
    $$values ('chatwoot_contacts', '7', 'conexao_nao_comprovada'),
             ('chatwoot_conversations', '70', 'conexao_nao_comprovada'),
             ('chatwoot_conversations', '80', 'contato_nao_vinculado'),
             ('chatwoot_messages', '700', 'conexao_nao_comprovada')$$,
    '10. sem prova ou com contato de outra instalação: quarentena, nunca palpite');
select is((select count(*)::int from public.chatwoot_messages where id >= 10000 and conexao_id is null), 0,
          '11. as 2500 mensagens da conversa 50 herdaram a conexão em vários lotes');
select is((select count(*)::int
             from public.chatwoot_messages m
             join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
            where v.id <> m.conversation_id or v.organizacao_id <> m.organizacao_id), 0,
          '12. todo vínculo local aponta para o mesmo pai legado e a mesma organização');
select is((select sum(atualizadas)::int from public.backfill_identidade_local_chatwoot(1000)), 0,
          '13. o backfill é idempotente');

-- A prova chega depois (o inbox 99 é mapeado): o backfill retoma.
insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id)
values ('e3000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-0000000000c1', 99);
select results_eq($$select tabela, atualizadas from public.backfill_identidade_local_chatwoot(1000)$$,
                  $$values ('chatwoot_contacts'::text, 1), ('chatwoot_conversations', 1), ('chatwoot_messages', 1)$$,
                  '14. com a prova nova, contato 7, conversa 70 e mensagem 700 saem da quarentena');
select set_eq($$select tabela, id_externo from public.chatwoot_identidade_em_quarentena$$,
              $$values ('chatwoot_conversations'::text, '80'::text)$$,
              '15. só a conversa que aponta para outra instalação continua em quarentena');
select is((select updated_at from public.chatwoot_contacts where id = 7), '2026-01-07 00:00+00'::timestamptz,
          '16. sair da quarentena também não troca o updated_at');

select * from finish();
rollback;
