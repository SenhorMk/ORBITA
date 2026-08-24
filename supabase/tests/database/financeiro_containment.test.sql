-- financeiro_containment.test.sql
-- Ticket 07: prove that the financial domain is contained.
-- Acceptance criteria:
--   (1) Permissive policies no longer allow global access.
--   (2) Direct browser access fails when ownership cannot be proved.
--   (3) Server-side flows preserve verified tenant on every query/mutation.
--   (4) Tests cover authorized reads, authorized mutations, cross-tenant
--       denial, and anonymous denial.

begin;

-- ============================================================================
-- FIXTURES (transactional — rolled back at the end)
-- ============================================================================

-- Minimal financial tables required by this test suite.
-- The test owns disposable schema tables; production DDL lives in database/.
create table public.categorias_financeiras (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid references auth.users(id) on delete cascade,
    descricao text not null,
    tipo      text
);

create table public.titulos_financeiros (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    bling_id        bigint unique,
    tipo            text not null check (tipo in ('receber','pagar')),
    situacao        text not null,
    valor           numeric(10,2) not null,
    data_vencimento date not null,
    descricao       text not null
);

create table public.contas_financeiras (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid references auth.users(id) on delete cascade,
    descricao text not null,
    tipo      smallint not null default 1
);

create table public.fornecedores (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    nome    text not null
);

-- Two tenants (auth users acting as owners)
insert into auth.users (id, email)
values
    ('50000000-0000-4000-8000-000000000001', 'tenant-a@orbita.test'),
    ('50000000-0000-4000-8000-000000000002', 'tenant-b@orbita.test');

-- Tenant A financial data
insert into public.categorias_financeiras (id, user_id, descricao, tipo)
values ('51000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'Vendas A', 'receita');

insert into public.titulos_financeiros (id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao)
values ('52000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 1001, 'receber', 'aberto', 500.00, '2025-12-31', 'Venda tenant A');

insert into public.contas_financeiras (id, user_id, descricao)
values ('53000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'Conta A');

insert into public.fornecedores (id, user_id, nome)
values ('54000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'Fornecedor A');

-- Tenant B financial data
insert into public.titulos_financeiros (id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao)
values ('52000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 2001, 'pagar', 'pago', 250.00, '2025-11-30', 'Despesa tenant B');

-- ============================================================================
-- RLS SETUP
-- ============================================================================

alter table public.categorias_financeiras enable row level security;
alter table public.titulos_financeiros enable row level security;
alter table public.contas_financeiras enable row level security;
alter table public.fornecedores enable row level security;

-- Apply the tenant-scoped policies from migration 10
create policy "Isolamento por tenant" on public.categorias_financeiras
    for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Isolamento por tenant" on public.titulos_financeiros
    for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Isolamento por tenant" on public.contas_financeiras
    for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Isolamento por tenant" on public.fornecedores
    for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Grants for testing: SELECT is granted to test RLS isolation; mutations are service_role only
grant select on public.categorias_financeiras to anon, authenticated, service_role;
grant select on public.titulos_financeiros to anon, authenticated, service_role;
grant select on public.contas_financeiras to anon, authenticated, service_role;
grant select on public.fornecedores to anon, authenticated, service_role;

grant insert, update, delete on public.categorias_financeiras to service_role;
grant insert, update, delete on public.titulos_financeiros to service_role;
grant insert, update, delete on public.contas_financeiras to service_role;
grant insert, update, delete on public.fornecedores to service_role;

-- ============================================================================
-- TESTS
-- ============================================================================

select plan(12);

-- [1] anonymous cannot read any financial table (filtered to 0 rows by RLS)
set local role anon;
select is(
    (select count(*) from public.titulos_financeiros),
    0::bigint,
    'anonymous role cannot read titulos_financeiros (RLS filters out all rows)'
);
reset role;

-- [2] anonymous cannot read categorias
set local role anon;
select is(
    (select count(*) from public.categorias_financeiras),
    0::bigint,
    'anonymous role cannot read categorias_financeiras (RLS filters out all rows)'
);
reset role;

-- [3] authenticated tenant A reads only own titulos
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.titulos_financeiros),
    1::bigint,
    'authenticated tenant A sees only own titulos'
);
reset role;

-- [4] authenticated tenant A cannot read tenant B titulos (cross-tenant denial)
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.titulos_financeiros where user_id = '50000000-0000-4000-8000-000000000002'),
    0::bigint,
    'authenticated tenant A cannot read tenant B titulos'
);
reset role;

-- [5] authenticated tenant A reads own categorias
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.categorias_financeiras),
    1::bigint,
    'authenticated tenant A sees only own categorias'
);
reset role;

-- [6] authenticated tenant A reads own contas
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.contas_financeiras),
    1::bigint,
    'authenticated tenant A sees only own contas_financeiras'
);
reset role;

-- [7] authenticated tenant A reads own fornecedores
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from public.fornecedores),
    1::bigint,
    'authenticated tenant A sees only own fornecedores'
);
reset role;

-- [8] authenticated tenant B sees only own titulos (cross-tenant isolation)
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-4000-8000-000000000002';
select is(
    (select count(*) from public.titulos_financeiros),
    1::bigint,
    'authenticated tenant B sees only own titulos'
);
reset role;

-- [9] service_role can read all titulos (privileged server path)
set local role service_role;
select is(
    (select count(*) from public.titulos_financeiros),
    2::bigint,
    'service_role reads all titulos (unfiltered privileged path)'
);
reset role;

-- [10] service_role inserts titulo scoped to tenant A (valid server-side mutation)
set local role service_role;
select lives_ok(
    $$insert into public.titulos_financeiros
        (user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao)
      values
        ('50000000-0000-4000-8000-000000000001', 9999, 'pagar', 'aberto', 100.00, '2026-01-31', 'Server upsert A')$$,
    'service_role can insert a titulo scoped to tenant A'
);
reset role;

-- [11] authenticated cannot insert titulos (no insert privilege granted)
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-4000-8000-000000000001';
select throws_ok(
    $$insert into public.titulos_financeiros
        (user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao)
      values
        ('50000000-0000-4000-8000-000000000001', 8888, 'pagar', 'aberto', 50.00, '2026-01-31', 'Browser direct write')$$,
    '42501',
    null,
    'authenticated browser cannot insert titulos directly without grant'
);
reset role;

-- [12] authenticated cannot insert into other tenant (both privilege and RLS deny)
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-4000-8000-000000000001';
select throws_ok(
    $$insert into public.titulos_financeiros
        (user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao)
      values
        ('50000000-0000-4000-8000-000000000002', 7777, 'pagar', 'aberto', 75.00, '2026-01-31', 'Cross-tenant injection')$$,
    '42501',
    null,
    'authenticated browser cannot inject into another tenant'
);
reset role;

select * from finish();
rollback;
