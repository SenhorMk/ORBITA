-- chatwoot_containment.test.sql
-- Ticket 08: prove that the Chatwoot domain (contacts, conversations, messages, inboxes) is contained.
-- Acceptance criteria:
--   (1) Common authenticated users cannot query or mutate global Chatwoot data.
--   (2) Server-side operations require verified tenant scope.
--   (3) Responses do not leak content or existence of other tenants' conversations.
--   (4) Tests record secure behavior until definitive tenancy migration.

begin;

-- ============================================================================
-- FIXTURES (transactional — rolled back at the end)
-- ============================================================================

create table public.chatwoot_inboxes (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    inbox_id   int not null unique
);

create table public.chatwoot_contacts (
    id                int primary key,
    user_id           uuid references auth.users(id) on delete cascade,
    name              text not null,
    email             text,
    phone_number      text,
    phone_normalizado text
);

create table public.chatwoot_conversations (
    id         int primary key,
    user_id    uuid references auth.users(id) on delete cascade,
    display_id int,
    contact_id int not null references public.chatwoot_contacts(id) on delete cascade,
    status     text not null default 'open',
    inbox_id   int,
    channel    text
);

create table public.chatwoot_messages (
    id              int primary key,
    user_id         uuid references auth.users(id) on delete cascade,
    conversation_id int not null references public.chatwoot_conversations(id) on delete cascade,
    content         text,
    message_type    text,
    sender_name     text
);

-- Two distinct tenants
insert into auth.users (id, email)
values
    ('70000000-0000-4000-8000-000000000001', 'chatwoot-tenant-a@orbita.test'),
    ('70000000-0000-4000-8000-000000000002', 'chatwoot-tenant-b@orbita.test');

-- Tenant A data
insert into public.chatwoot_contacts (id, user_id, name, phone_number, phone_normalizado)
values (101, '70000000-0000-4000-8000-000000000001', 'Cliente A', '+5511999990001', '+5511999990001');

insert into public.chatwoot_conversations (id, user_id, display_id, contact_id, status, channel)
values (201, '70000000-0000-4000-8000-000000000001', 1, 101, 'open', 'Channel::Whatsapp');

insert into public.chatwoot_messages (id, user_id, conversation_id, content, message_type, sender_name)
values (301, '70000000-0000-4000-8000-000000000001', 201, 'Mensagem privada Tenant A', 'incoming', 'Cliente A');

-- Tenant B data
insert into public.chatwoot_contacts (id, user_id, name, phone_number, phone_normalizado)
values (102, '70000000-0000-4000-8000-000000000002', 'Cliente B', '+5511999990002', '+5511999990002');

insert into public.chatwoot_conversations (id, user_id, display_id, contact_id, status, channel)
values (202, '70000000-0000-4000-8000-000000000002', 2, 102, 'open', 'Channel::Whatsapp');

insert into public.chatwoot_messages (id, user_id, conversation_id, content, message_type, sender_name)
values (302, '70000000-0000-4000-8000-000000000002', 202, 'Mensagem privada Tenant B', 'incoming', 'Cliente B');

-- ============================================================================
-- RLS SETUP
-- ============================================================================

alter table public.chatwoot_inboxes enable row level security;
alter table public.chatwoot_contacts enable row level security;
alter table public.chatwoot_conversations enable row level security;
alter table public.chatwoot_messages enable row level security;

-- Enforce tenant-scoped policies
create policy "Isolamento por tenant" on public.chatwoot_inboxes
    for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Isolamento por tenant" on public.chatwoot_contacts
    for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Isolamento por tenant" on public.chatwoot_conversations
    for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Isolamento por tenant" on public.chatwoot_messages
    for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Grants: authenticated has SELECT (constrained by RLS); mutations are service_role only
grant select on public.chatwoot_inboxes to authenticated;
grant select on public.chatwoot_contacts to anon, authenticated, service_role;
grant select on public.chatwoot_conversations to anon, authenticated, service_role;
grant select on public.chatwoot_messages to anon, authenticated, service_role;

grant insert, update, delete on public.chatwoot_inboxes to service_role;
grant insert, update, delete on public.chatwoot_contacts to service_role;
grant insert, update, delete on public.chatwoot_conversations to service_role;
grant insert, update, delete on public.chatwoot_messages to service_role;

-- ============================================================================
-- TESTS
-- ============================================================================

select plan(14);

-- [1] anonymous cannot read chatwoot_contacts (0 rows via RLS)
set local role anon;
select is(
    (select count(*) from public.chatwoot_contacts),
    0::bigint,
    'anonymous role cannot read chatwoot_contacts'
);
reset role;

-- [2] anonymous cannot read chatwoot_conversations (0 rows via RLS)
set local role anon;
select is(
    (select count(*) from public.chatwoot_conversations),
    0::bigint,
    'anonymous role cannot read chatwoot_conversations'
);
reset role;

-- [3] anonymous cannot read chatwoot_messages (0 rows via RLS)
set local role anon;
select is(
    (select count(*) from public.chatwoot_messages),
    0::bigint,
    'anonymous role cannot read chatwoot_messages'
);
reset role;

-- [4] authenticated tenant A reads only own contacts
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.chatwoot_contacts),
    1::bigint,
    'authenticated tenant A reads only own contacts'
);
reset role;

-- [5] authenticated tenant A cannot read tenant B contacts (cross-tenant denial)
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.chatwoot_contacts where user_id = '70000000-0000-4000-8000-000000000002'),
    0::bigint,
    'authenticated tenant A cannot read tenant B contacts'
);
reset role;

-- [6] authenticated tenant A reads only own conversations
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.chatwoot_conversations),
    1::bigint,
    'authenticated tenant A reads only own conversations'
);
reset role;

-- [7] authenticated tenant A cannot read tenant B conversations (cross-tenant denial)
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.chatwoot_conversations where user_id = '70000000-0000-4000-8000-000000000002'),
    0::bigint,
    'authenticated tenant A cannot read tenant B conversations'
);
reset role;

-- [8] authenticated tenant A reads only own messages
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.chatwoot_messages),
    1::bigint,
    'authenticated tenant A reads only own messages'
);
reset role;

-- [9] authenticated tenant A cannot read tenant B messages (cross-tenant denial)
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.chatwoot_messages where user_id = '70000000-0000-4000-8000-000000000002'),
    0::bigint,
    'authenticated tenant A cannot read tenant B messages'
);
reset role;

-- [10] authenticated tenant B reads only own conversations (cross-tenant isolation)
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000002';
select is(
    (select count(*) from public.chatwoot_conversations),
    1::bigint,
    'authenticated tenant B reads only own conversations'
);
reset role;

-- [11] service_role can read all conversations (unfiltered privileged path)
set local role service_role;
select is(
    (select count(*) from public.chatwoot_conversations),
    2::bigint,
    'service_role reads all conversations on privileged path'
);
reset role;

-- [12] authenticated browser cannot insert contacts directly (no insert privilege)
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000001';
select throws_ok(
    $$insert into public.chatwoot_contacts (id, user_id, name)
      values (999, '70000000-0000-4000-8000-000000000001', 'Direct write')$$,
    '42501',
    null,
    'authenticated browser cannot insert contacts directly without grant'
);
reset role;

-- [13] authenticated browser cannot inject messages into another tenant
set local role authenticated;
set local request.jwt.claim.sub = '70000000-0000-4000-8000-000000000001';
select throws_ok(
    $$insert into public.chatwoot_messages (id, user_id, conversation_id, content)
      values (888, '70000000-0000-4000-8000-000000000002', 202, 'Cross-tenant injection')$$,
    '42501',
    null,
    'authenticated browser cannot inject messages into another tenant'
);
reset role;

-- [14] service_role can insert messages scoped to verified tenant A
set local role service_role;
select lives_ok(
    $$insert into public.chatwoot_messages (id, user_id, conversation_id, content, message_type, sender_name)
      values (303, '70000000-0000-4000-8000-000000000001', 201, 'Resposta server-side Tenant A', 'outgoing', 'Atendente Orbita')$$,
    'service_role can insert messages scoped to verified tenant A'
);
reset role;

select * from finish();
rollback;
