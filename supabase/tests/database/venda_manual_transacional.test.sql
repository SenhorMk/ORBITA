-- venda_manual_transacional.test.sql
-- Ticket 31b (orbita-mvp-producao-v2), migration 53.
--
-- Prova as duas correcoes da venda manual:
--   1. `pedidos.bling_id`/`numero` aceitam NULL — uma venda nao sincronizada
--      deixa de precisar de um identificador inventado.
--   2. `registrar_venda_manual` e atomica: estoque insuficiente no segundo item
--      nao pode deixar pedido, item nem titulo financeiro para tras. Era
--      exatamente esse o buraco das quatro chamadas separadas.

begin;

-- Tabelas-base reconstruidas como nos demais testes desta suite (schema_master
-- nao e executavel isoladamente), ja no estado pos-contract: `organizacao_id`
-- presente e obrigatoria.
create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              text,
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
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references auth.users(id) on delete cascade,
    pedido_id    uuid references public.pedidos(id) on delete set null,
    bling_id     text,
    tipo         text not null default 'NFE',
    numero       text not null,
    status       text not null default 'Emitida',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- `titulos_financeiros` no estado final (migration 45): organizacao obrigatoria.
create table public.titulos_financeiros (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
    organizacao_id    uuid not null,
    bling_id          text,
    tipo              text not null,
    situacao          text not null,
    valor             numeric(12,2) not null default 0,
    data_vencimento   date,
    data_pagamento    date,
    descricao         text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- `sync_state`: a migration 53 devolve o grant que a 09 revogou.
create table public.sync_state (
    id          uuid primary key default gen_random_uuid(),
    chave       text not null,
    valor       jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now()
);

insert into auth.users (id, email)
values
    ('a1000000-0000-4000-8000-000000000001', 'owner-a-t31b@orbita.test'),
    ('a1000000-0000-4000-8000-000000000002', 'owner-b-t31b@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/22_migrar_catalogo_organizacao.sql
\ir ../../../database/23_migrar_comercial_estoque_fiscal.sql
\ir ../../../database/40_expand_verificar_catalogo_comercial_estoque_fiscal.sql
\ir ../../../database/53_venda_manual_transacional.sql

insert into public.organizacoes (id, nome, slug) values
    ('a1100000-0000-4000-8000-000000000001', 'Org A T31b', 'org-a-t31b'),
    ('a1100000-0000-4000-8000-000000000002', 'Org B T31b', 'org-b-t31b');

insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('a1100000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'owner'),
    ('a1100000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 'owner');

insert into public.clientes (id, user_id, organizacao_id, bling_id, nome) values
    ('a1300000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000001', '111', 'Cliente A'),
    ('a1300000-0000-4000-8000-00000000000b', 'a1000000-0000-4000-8000-000000000002', 'a1100000-0000-4000-8000-000000000002', '222', 'Cliente B');

insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque) values
    ('a1200000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000001', '77', 'Camiseta', 49.90, 10),
    ('a1200000-0000-4000-8000-00000000000c', 'a1000000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000001', '78', 'Bone', 29.90, 1),
    ('a1200000-0000-4000-8000-00000000000b', 'a1000000-0000-4000-8000-000000000002', 'a1100000-0000-4000-8000-000000000002', '79', 'Produto de B', 10.00, 50);

select plan(11);

-- ----------------------------------------------------------------------------
-- 1-2. bling_id e numero passam a aceitar NULL.
-- ----------------------------------------------------------------------------
select col_is_null('public', 'pedidos', 'bling_id', 'pedidos.bling_id aceita NULL: sem Bling nao ha id do Bling');
select col_is_null('public', 'pedidos', 'numero', 'pedidos.numero aceita NULL na venda nao sincronizada');

-- ----------------------------------------------------------------------------
-- 3-6. Venda completa numa unica chamada.
-- ----------------------------------------------------------------------------
create temp table venda_ok as
select public.registrar_venda_manual(
    'a1100000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'a1300000-0000-4000-8000-00000000000a',
    null, null,
    99.80, 0, 0, 'Dinheiro', null, current_date,
    '[{"produto_id":"a1200000-0000-4000-8000-00000000000a","quantidade":2,"valor_unitario":49.90}]'::jsonb
) as pedido_id;

select is(
    (select count(*) from public.pedidos where id = (select pedido_id from venda_ok)),
    1::bigint,
    'a venda cria o pedido'
);

select is(
    (select count(*) from public.itens_pedido where pedido_id = (select pedido_id from venda_ok)),
    1::bigint,
    'a venda cria o item na mesma chamada'
);

select is(
    (select estoque from public.produtos where id = 'a1200000-0000-4000-8000-00000000000a'),
    8,
    'a venda baixa o estoque do produto'
);

select is(
    (select count(*) from public.titulos_financeiros
     where organizacao_id = 'a1100000-0000-4000-8000-000000000001'),
    1::bigint,
    'a venda cria o titulo financeiro COM organizacao_id — a omissao derrubava a venda inteira'
);

-- ----------------------------------------------------------------------------
-- 7-9. Atomicidade: estoque insuficiente no segundo item nao deixa nada atras.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$select public.registrar_venda_manual(
        'a1100000-0000-4000-8000-000000000001',
        'a1000000-0000-4000-8000-000000000001',
        'a1300000-0000-4000-8000-00000000000a',
        null, null,
        129.70, 0, 0, 'Dinheiro', null, current_date,
        '[{"produto_id":"a1200000-0000-4000-8000-00000000000a","quantidade":1,"valor_unitario":49.90},
          {"produto_id":"a1200000-0000-4000-8000-00000000000c","quantidade":5,"valor_unitario":29.90}]'::jsonb
    )$$,
    '23514',
    'Estoque insuficiente para o produto.',
    'a venda falha quando um item nao tem estoque'
);

select is(
    (select count(*) from public.pedidos where total = 129.70),
    0::bigint,
    'a falha de estoque nao deixa pedido orfao para tras'
);

select is(
    (select estoque from public.produtos where id = 'a1200000-0000-4000-8000-00000000000a'),
    8,
    'a falha de estoque nao consome o estoque do primeiro item'
);

-- ----------------------------------------------------------------------------
-- 10. Cliente de outra organizacao e recusado.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$select public.registrar_venda_manual(
        'a1100000-0000-4000-8000-000000000001',
        'a1000000-0000-4000-8000-000000000001',
        'a1300000-0000-4000-8000-00000000000b',
        null, null,
        10, 0, 0, null, null, current_date,
        '[{"produto_id":"a1200000-0000-4000-8000-00000000000a","quantidade":1,"valor_unitario":10}]'::jsonb
    )$$,
    'P0002',
    'Cliente nao encontrado para a organizacao verificada.',
    'a venda recusa cliente de outra organizacao'
);

-- ----------------------------------------------------------------------------
-- 11. A RPC nao e executavel pelos papeis do navegador.
-- ----------------------------------------------------------------------------
select is(
    (select count(*)::int
     from information_schema.routine_privileges
     where routine_schema = 'public'
       and routine_name = 'registrar_venda_manual'
       and grantee in ('anon', 'authenticated')),
    0,
    'registrar_venda_manual nao e executavel por anon nem authenticated'
);

select * from finish();
rollback;
