-- ============================================================================
-- contrair_tenancy_legado.test.sql
-- Testes pgTAP para o Ticket 36: Contrair o tenancy legado por usuário
-- ============================================================================

begin;

-- Fixtures descartáveis isoladas para suportar a migration 32
create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    organizacao_id        uuid,
    bling_id              text not null,
    nome                  text not null,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
    organizacao_id    uuid,
    bling_id          text,
    nome              text not null,
    preco             numeric(10,2) not null default 0,
    estoque           integer not null default 0,
    estoque_reservado integer not null default 0,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create table public.categorias (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid references auth.users(id) on delete cascade,
    organizacao_id   uuid,
    bling_id         text,
    descricao        text not null,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.pedidos (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    organizacao_id  uuid,
    bling_id        text not null,
    numero          text not null,
    data            timestamptz not null default now(),
    cliente_id      uuid references public.clientes(id) on delete restrict,
    total           numeric(12,2) not null default 0.00,
    status          text not null default 'Pendente',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table public.itens_pedido (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    organizacao_id  uuid,
    pedido_id       uuid not null references public.pedidos(id) on delete cascade,
    produto_id      uuid not null references public.produtos(id) on delete restrict,
    quantidade      int not null default 1,
    valor_unitario  numeric(12,2) not null default 0.00,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table public.documentos_fiscais (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid references auth.users(id) on delete cascade,
    organizacao_id   uuid,
    numero           text not null default 'DF-1',
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.titulos_financeiros (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid references auth.users(id) on delete cascade,
    organizacao_id   uuid,
    descricao        text not null default 'Titulo',
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.categorias_financeiras (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid references auth.users(id) on delete cascade,
    organizacao_id   uuid,
    descricao        text not null default 'Cat Fin',
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.chatwoot_conversations (
    id               int primary key,
    user_id          uuid references auth.users(id) on delete cascade,
    organizacao_id   uuid,
    status           text not null default 'open',
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.chatwoot_messages (
    id               int primary key,
    user_id          uuid references auth.users(id) on delete cascade,
    organizacao_id   uuid,
    conversation_id  int not null references public.chatwoot_conversations(id) on delete cascade,
    content          text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.chatwoot_contacts (
    id               int primary key,
    user_id          uuid references auth.users(id) on delete cascade,
    organizacao_id   uuid,
    name             text not null,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.sync_state (
    user_id          uuid not null references auth.users(id) on delete cascade,
    entidade         text not null,
    last_synced_at   timestamptz,
    updated_at       timestamptz not null default now(),
    primary key (user_id, entidade)
);

insert into auth.users (id, email)
values ('99900000-0000-4000-8000-000000000001', 'owner-t36@orbita.test'),
       ('99900000-0000-4000-8000-000000000002', 'collab-t36@orbita.test'),
       ('99900000-0000-4000-8000-000000000003', 'external-t36@orbita.test');

\ir .generated/20_organizacao_membership_ativa.inc
\ir .generated/32_contrair_tenancy_legado.inc

grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated, service_role;

select plan(8);

-- Setup: Criar Org A com Owner 1
set local role authenticated;
set local request.jwt.claim.sub = '99900000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Contracao A', 'org-contracao-a-36') as org_id;

-- Adicionar colaborador 2 na Org A
set local role postgres;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org_a), '99900000-0000-4000-8000-000000000002'::uuid, 'member');

-- Setup Org B para usuário externo 3
set local role authenticated;
set local request.jwt.claim.sub = '99900000-0000-4000-8000-000000000003';
create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Contracao B', 'org-contracao-b-36') as org_id;

reset role;

-- 1. Coluna organizacao_id existe em sync_state
select has_column('public', 'sync_state', 'organizacao_id', 'Coluna organizacao_id existe em sync_state');

-- 2. Tabela produtos existe
select has_table('public', 'produtos', 'Tabela produtos existe');

-- 3. Tabela pedidos existe
select has_table('public', 'pedidos', 'Tabela pedidos existe');

-- Inserir dados de teste vinculados à Org A
insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, preco, estoque)
values ('99910000-0000-4000-8000-000000000001'::uuid, (select org_id from temp_org_a), '99900000-0000-4000-8000-000000000001'::uuid, 'PROD-ORG-101', 'Produto Org A', 50.00, 100);

insert into public.clientes (id, organizacao_id, user_id, bling_id, nome)
values ('99920000-0000-4000-8000-000000000001'::uuid, (select org_id from temp_org_a), '99900000-0000-4000-8000-000000000001'::uuid, 'CLI-ORG-101', 'Cliente Org A');

insert into public.pedidos (id, organizacao_id, user_id, bling_id, cliente_id, numero, data, total, status)
values ('99930000-0000-4000-8000-000000000001'::uuid, (select org_id from temp_org_a), '99900000-0000-4000-8000-000000000001'::uuid, 'PED-ORG-101', '99920000-0000-4000-8000-000000000001'::uuid, 'PED-101', now(), 50.00, 'Pendente');

-- 4. Colaborador da Org A tem acesso aos produtos da organização
set local role authenticated;
set local request.jwt.claim.sub = '99900000-0000-4000-8000-000000000002';

select is(
    (select count(*) from public.produtos where organizacao_id = (select org_id from temp_org_a)),
    1::bigint,
    'Colaborador da organizacao consegue ler produtos da organizacao'
);

-- 5. Colaborador da Org A tem acesso aos clientes da organização
select is(
    (select count(*) from public.clientes where organizacao_id = (select org_id from temp_org_a)),
    1::bigint,
    'Colaborador da organizacao consegue ler clientes da organizacao'
);

-- 6. Colaborador da Org A tem acesso aos pedidos da organização
select is(
    (select count(*) from public.pedidos where organizacao_id = (select org_id from temp_org_a)),
    1::bigint,
    'Colaborador da organizacao consegue ler pedidos da organizacao'
);

-- 7. Usuário externo não tem acesso aos produtos da Org A
set local role authenticated;
set local request.jwt.claim.sub = '99900000-0000-4000-8000-000000000003';

select is(
    (select count(*) from public.produtos where organizacao_id = (select org_id from temp_org_a)),
    0::bigint,
    'Usuario externo nao tem acesso aos produtos da Org A (RLS isolado)'
);

-- 8. Usuário externo não tem acesso aos pedidos da Org A
set local role authenticated;
set local request.jwt.claim.sub = '99900000-0000-4000-8000-000000000003';

select is(
    (select count(*) from public.pedidos where organizacao_id = (select org_id from temp_org_a)),
    0::bigint,
    'Usuario externo nao tem acesso aos pedidos da Org A (RLS isolado)'
);

select * from finish();
rollback;
