-- comercial_organizacao.test.sql
-- Ticket 27: Migrar clientes, pedidos, estoque e fiscal para a organização

begin;

create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              text not null,
    nome                  text not null,
    cpf_cnpj              text,
    email                 text,
    telefone              text,
    telefone_normalizado  text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
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
    bling_id         text,
    descricao        text not null,
    categoria_pai_id text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.pedidos (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    bling_id        text not null,
    numero          text not null,
    data            timestamptz not null default now(),
    cliente_id      uuid not null references public.clientes(id) on delete restrict,
    total           numeric(12,2) not null default 0.00,
    frete           numeric(12,2) default 0.00,
    desconto        numeric(12,2) default 0.00,
    status          text not null default 'Pendente',
    origem          text not null default 'Bling',
    forma_pagamento text,
    observacao      text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table public.itens_pedido (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    pedido_id       uuid not null references public.pedidos(id) on delete cascade,
    produto_id      uuid not null references public.produtos(id) on delete restrict,
    quantidade      int not null default 1,
    valor_unitario  numeric(12,2) not null default 0.00,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table public.movimentacao_estoque (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references auth.users(id) on delete cascade,
    produto_id   uuid not null references public.produtos(id) on delete cascade,
    tipo         text not null check (tipo in ('ENTRADA', 'SAIDA')),
    origem       text,
    quantidade   int not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create table public.documentos_fiscais (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    pedido_id       uuid references public.pedidos(id) on delete set null,
    bling_id        text,
    tipo            text not null default 'NFE',
    numero          text not null,
    serie           text,
    chave_acesso    text,
    status          text not null default 'Emitida',
    valor_total     numeric(12, 2),
    xml_url         text,
    danfe_url       text,
    emitida_em      timestamptz,
    dados_extras    jsonb,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

insert into auth.users (id, email)
values ('98000000-0000-4000-8000-000000000001', 'owner-comercial@orbita.test'),
       ('98000000-0000-4000-8000-000000000002', 'collab-comercial@orbita.test'),
       ('98000000-0000-4000-8000-000000000003', 'stranger-comercial@orbita.test');

\ir .generated/20_organizacao_membership_ativa.inc
\ir .generated/21_convites_papeis_capacidades.inc
\ir .generated/22_migrar_catalogo_organizacao.inc
\ir .generated/23_migrar_comercial_estoque_fiscal.inc

select plan(9);

-- 1. Setup: Criar Org A
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Comercial Org A', 'comercial-org-a') as org_id;

-- Associar Colaborador na Org A
set local role postgres;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org_a), '98000000-0000-4000-8000-000000000002'::uuid, 'member');

-- Criar Org B para o usuário Stranger
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000003';

create temp table temp_org_b as
select public.criar_organizacao_atomica('Comercial Org B', 'comercial-org-b') as org_id;

-- 2. Owner da Org A insere registros
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000001';

insert into public.clientes (id, user_id, bling_id, nome, email)
values ('98100000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 'cli-1', 'Cliente Org A', 'cli@orga.test');

insert into public.produtos (id, user_id, bling_id, nome, preco, estoque)
values ('98200000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 'prod-1', 'Produto Org A', 150.00, 20);

insert into public.pedidos (id, user_id, bling_id, numero, data, cliente_id, total)
values ('98300000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 'ped-1', '1001', now(), '98100000-0000-4000-8000-000000000001', 150.00);

insert into public.itens_pedido (id, user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('98400000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', '98300000-0000-4000-8000-000000000001', '98200000-0000-4000-8000-000000000001', 1, 150.00);

insert into public.documentos_fiscais (id, user_id, pedido_id, numero, status, valor_total)
values ('98500000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', '98300000-0000-4000-8000-000000000001', 'NFE-1001', 'Emitida', 150.00);

-- Asserção 1: Cliente auto-preencheu organizacao_id
select is(
    (select organizacao_id from public.clientes where id = '98100000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Cliente foi automaticamente associado a organizacao A'
);

-- Asserção 2: Pedido auto-preencheu organizacao_id
select is(
    (select organizacao_id from public.pedidos where id = '98300000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Pedido foi automaticamente associado a organizacao A'
);

-- Asserção 3: Itens e Documentos Fiscais herdaram organizacao_id do pedido
select is(
    (select organizacao_id from public.itens_pedido where id = '98400000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Item do pedido foi associado a organizacao A'
);

select is(
    (select organizacao_id from public.documentos_fiscais where id = '98500000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Documento fiscal foi associado a organizacao A'
);

-- Asserção 4 & 5: Colaborador membro da Org A lê Pedido e NFe (RLS)
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000002';

select is(
    (select count(*) from public.pedidos where id = '98300000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Colaborador membro da Org A enxerga o pedido via RLS'
);

select is(
    (select count(*) from public.documentos_fiscais where id = '98500000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Colaborador membro da Org A enxerga o documento fiscal via RLS'
);

-- Asserção 6: Membro da Org B (Stranger) é bloqueado por RLS de ver dados da Org A
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000003';

select is(
    (select count(*) from public.pedidos where id = '98300000-0000-4000-8000-000000000001'::uuid),
    0::bigint,
    'Usuario de outro tenant nao enxerga pedidos da Org A'
);

-- Asserção 7: Validação Anti Cross-Tenant bloqueia pedido com cliente de outra org
select throws_ok(
    $$insert into public.pedidos (user_id, bling_id, numero, data, cliente_id, total)
      values ('98000000-0000-4000-8000-000000000003', 'ped-b-cross', '2001', now(), '98100000-0000-4000-8000-000000000001', 50.00)$$,
    '23503',
    null,
    'Trigger bloqueia criacao de pedido com cliente de outra organizacao'
);

-- Asserção 8: Backfill histórico executa com sucesso
set local role postgres;
select lives_ok(
    $$select public.migrar_comercial_para_organizacoes()$$,
    'Procedimento migrar_comercial_para_organizacoes executa sem erros'
);

select * from finish();
rollback;
