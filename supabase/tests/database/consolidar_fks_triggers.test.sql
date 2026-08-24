-- consolidar_fks_triggers.test.sql
-- Ticket 21: Consolidar foreign keys e triggers

begin;

-- Fixtures descartáveis
create table public.clientes (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    nome       text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.pedidos (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    cliente_id uuid references public.clientes(id) on delete restrict,
    numero     text not null,
    total      numeric(10,2) default 0,
    status     text default 'Pendente',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.itens_pedido (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    pedido_id  uuid not null references public.pedidos(id) on delete cascade,
    produto_id uuid,
    quantidade integer not null default 1,
    valor_unit numeric(10,2) not null default 0
);

create table public.categorias_financeiras (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    descricao  text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.contas_financeiras (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    descricao  text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.fornecedores (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    nome       text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.titulos_financeiros (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid references auth.users(id) on delete cascade,
    tipo                text not null check (tipo in ('receber','pagar')),
    situacao            text not null,
    valor               numeric(10,2) not null,
    data_vencimento     date not null,
    descricao           text not null,
    categoria_id        uuid,
    conta_financeira_id uuid,
    fornecedor_id       uuid,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

insert into auth.users (id, email)
values ('75000000-0000-4000-8000-000000000001', 'tenant-fks@orbita.test');

\ir ../../../database/17_consolidar_fks_e_triggers.sql

select plan(5);

-- 1. Inserir fornecedor e titulo associado
insert into public.fornecedores (id, user_id, nome, updated_at)
values ('75100000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000001', 'Fornecedor XYZ', '2025-01-01 00:00:00+00');

insert into public.titulos_financeiros (
    id, user_id, tipo, situacao, valor, data_vencimento, descricao, fornecedor_id
) values (
    '75200000-0000-4000-8000-000000000001',
    '75000000-0000-4000-8000-000000000001',
    'pagar',
    'aberto',
    100.00,
    current_date,
    'Titulo de Teste FK',
    '75100000-0000-4000-8000-000000000001'
);

-- 2. Testar trigger updated_at no fornecedor
update public.fornecedores
set nome = 'Fornecedor XYZ Atualizado'
where id = '75100000-0000-4000-8000-000000000001'::uuid;

select is(
    (select updated_at > '2025-01-01 00:00:00+00'::timestamptz from public.fornecedores where id = '75100000-0000-4000-8000-000000000001'::uuid),
    true,
    'Trigger tg_fornecedores_updated_at atualizou o campo updated_at automaticamente'
);

-- 3. Deletar o fornecedor e comprovar ON DELETE SET NULL em titulos_financeiros
delete from public.fornecedores where id = '75100000-0000-4000-8000-000000000001'::uuid;

select is(
    (select count(*) from public.titulos_financeiros where id = '75200000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Titulo financeiro nao foi apagado quando seu fornecedor foi excluido'
);

select is(
    (select fornecedor_id from public.titulos_financeiros where id = '75200000-0000-4000-8000-000000000001'::uuid),
    null,
    'Campo fornecedor_id no titulo financeiro foi setado para NULL (ON DELETE SET NULL)'
);

-- 4. Testar integridade de Pedidos e Itens (ON DELETE CASCADE)
insert into public.pedidos (id, user_id, numero)
values ('75300000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000001', 'PED-CASCADE-1');

insert into public.itens_pedido (id, user_id, pedido_id, quantidade, valor_unit)
values ('75400000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000001', '75300000-0000-4000-8000-000000000001', 2, 50.00);

delete from public.pedidos where id = '75300000-0000-4000-8000-000000000001'::uuid;

select is(
    (select count(*) from public.itens_pedido where id = '75400000-0000-4000-8000-000000000001'::uuid),
    0::bigint,
    'Itens do pedido foram removidos em cascata (ON DELETE CASCADE) ao excluir o pedido'
);

-- 5. Testar que exclusão de cliente sem pedidos funciona
insert into public.clientes (id, user_id, nome)
values ('75500000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000001', 'Cliente Sem Pedidos');

delete from public.clientes where id = '75500000-0000-4000-8000-000000000001'::uuid;

select is(
    (select count(*) from public.clientes where id = '75500000-0000-4000-8000-000000000001'::uuid),
    0::bigint,
    'Cliente sem pedidos foi excluido com sucesso'
);

select * from finish();
rollback;
