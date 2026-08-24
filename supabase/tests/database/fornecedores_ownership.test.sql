-- fornecedores_ownership.test.sql
-- Ticket 17: Dar ownership a fornecedores e escopar IDs externos

begin;

-- Fixtures descartáveis
create table public.fornecedores (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid references auth.users(id) on delete cascade,
    bling_id      bigint,
    nome          text not null,
    nome_fantasia text
);

create table public.categorias_financeiras (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid references auth.users(id) on delete cascade,
    bling_id  bigint,
    descricao text not null,
    tipo      text
);

create table public.contas_financeiras (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid references auth.users(id) on delete cascade,
    bling_id  bigint,
    descricao text not null,
    tipo      smallint not null default 1
);

create table public.titulos_financeiros (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid references auth.users(id) on delete cascade,
    bling_id            bigint,
    tipo                text not null check (tipo in ('receber','pagar')),
    situacao            text not null,
    valor               numeric(10,2) not null,
    data_vencimento     date not null,
    descricao           text not null,
    categoria_id        uuid references public.categorias_financeiras(id),
    conta_financeira_id uuid references public.contas_financeiras(id),
    fornecedor_id       uuid references public.fornecedores(id)
);

insert into auth.users (id, email)
values
    ('71000000-0000-4000-8000-000000000001', 'tenant-a@orbita.test'),
    ('71000000-0000-4000-8000-000000000002', 'tenant-b@orbita.test');

\ir .generated/13_ownership_fornecedores_ids_externos.inc

select plan(7);

-- 1. Tenant A e Tenant B criam fornecedores com o MESMO bling_id (777888) sem conflito
insert into public.fornecedores (id, user_id, bling_id, nome)
values
    ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 777888, 'Distribuidora Alpha Tenant A'),
    ('72000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000002', 777888, 'Distribuidora Beta Tenant B');

select is(
    (select count(*) from public.fornecedores where bling_id = 777888),
    2::bigint,
    'Dois tenants podem possuir fornecedores com o mesmo bling_id sem colisão'
);

-- 2. Tenant A tenta inserir um SEGUNDO fornecedor com o mesmo bling_id (deve falhar por unicidade no tenant)
select throws_ok(
    $$
    insert into public.fornecedores (id, user_id, bling_id, nome)
    values ('72000000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000001', 777888, 'Duplicado Tenant A')
    $$,
    '23505',
    NULL,
    'Unicidade de bling_id eh estritamente mantida dentro do escopo do mesmo tenant'
);

-- 3. Criar categorias para os tenants
insert into public.categorias_financeiras (id, user_id, bling_id, descricao)
values
    ('73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 5001, 'Insumos Tenant A'),
    ('73000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000002', 5001, 'Insumos Tenant B');

-- 4. Tenant A cria titulo com seus proprios fornecedor_id e categoria_id (deve suceder)
insert into public.titulos_financeiros (
    id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, categoria_id, fornecedor_id
) values (
    '74000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001',
    9001,
    'pagar',
    'aberto',
    300.00,
    current_date,
    'Compra Legitima Tenant A',
    '73000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001'
);

select is(
    (select count(*) from public.titulos_financeiros where id = '74000000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Tenant A consegue vincular seus proprios fornecedores e categorias ao titulo'
);

-- 5. Tenant A tenta vincular fornecedor pertencente ao Tenant B (deve ser bloqueado pelo trigger anti-cross-tenant)
select throws_ok(
    $$
    insert into public.titulos_financeiros (
        id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, fornecedor_id
    ) values (
        '74000000-0000-4000-8000-000000000002',
        '71000000-0000-4000-8000-000000000001',
        9002,
        'pagar',
        'aberto',
        400.00,
        current_date,
        'Tentativa Cross-Tenant Fornecedor',
        '72000000-0000-4000-8000-000000000002'
    )
    $$,
    '23503',
    NULL,
    'Trigger impede que Tenant A referencie fornecedor pertencente ao Tenant B'
);

-- 6. Tenant A tenta vincular categoria pertencente ao Tenant B (deve ser bloqueado pelo trigger anti-cross-tenant)
select throws_ok(
    $$
    insert into public.titulos_financeiros (
        id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, categoria_id
    ) values (
        '74000000-0000-4000-8000-000000000003',
        '71000000-0000-4000-8000-000000000001',
        9003,
        'pagar',
        'aberto',
        500.00,
        current_date,
        'Tentativa Cross-Tenant Categoria',
        '73000000-0000-4000-8000-000000000002'
    )
    $$,
    '23503',
    NULL,
    'Trigger impede que Tenant A referencie categoria pertencente ao Tenant B'
);

-- 7. Isolamento RLS: Tenant A autenticado le apenas seu fornecedor
grant select on public.fornecedores to anon, authenticated, service_role;
set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-4000-8000-000000000001';

select is(
    (select count(*) from public.fornecedores),
    1::bigint,
    'Tenant A autenticado enxerga somente seu proprio fornecedor sob RLS'
);

select is(
    (select nome from public.fornecedores limit 1),
    'Distribuidora Alpha Tenant A',
    'Nome do fornecedor retornado corresponde ao Tenant A'
);

reset role;

select * from finish();
rollback;
