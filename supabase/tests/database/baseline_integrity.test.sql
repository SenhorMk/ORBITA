-- baseline_integrity.test.sql
-- Ticket 23: Comprovar integridade da baseline saneada

begin;

-- Fixtures descartáveis
create table public.clientes (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade
);

create table public.pedidos (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references auth.users(id) on delete cascade,
    cliente_id uuid references public.clientes(id)
);

create table public.itens_pedido (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid not null references auth.users(id) on delete cascade,
    pedido_id uuid not null references public.pedidos(id)
);

create table public.produtos (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade
);

create table public.fornecedores (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade
);

create table public.categorias_financeiras (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade
);

create table public.contas_financeiras (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade
);

create table public.titulos_financeiros (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references auth.users(id) on delete cascade,
    fornecedor_id       uuid references public.fornecedores(id),
    categoria_id        uuid references public.categorias_financeiras(id),
    conta_financeira_id uuid references public.contas_financeiras(id)
);

create table public.documentos_fiscais (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid not null references auth.users(id) on delete cascade,
    pedido_id uuid references public.pedidos(id)
);

create table public.movimentacao_estoque (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade
);

create table public.chatwoot_conversations (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade
);

create table public.chatwoot_messages (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    conversation_id uuid references public.chatwoot_conversations(id)
);

insert into auth.users (id, email)
values ('85000000-0000-4000-8000-000000000001', 'tenant-a@orbita.test'),
       ('85000000-0000-4000-8000-000000000002', 'tenant-b@orbita.test');

\ir .generated/19_comprovar_integridade_baseline.inc

select plan(4);

-- 1. Inserir dados válidos e consistentes para tenant A e tenant B
insert into public.fornecedores (id, user_id)
values ('85100000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001');

insert into public.titulos_financeiros (id, user_id, fornecedor_id)
values ('85200000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', '85100000-0000-4000-8000-000000000001');

-- 2. Executar verificar_integridade_baseline() e comprovar ZERO infrações
select is(
    (select sum(infracoes)::bigint from public.verificar_integridade_baseline()),
    0::bigint,
    'Baseline integra: soma total de infracoes (user_id nulo + cross-tenant) e exatamente 0'
);

select is(
    (select count(*) from public.verificar_integridade_baseline() where infracoes > 0),
    0::bigint,
    'Todas as verificacoes individuais reportam 0 infracoes'
);

-- 3. Inserir dado cross-tenant em tabela e comprovar detecção pela função de integridade
insert into public.titulos_financeiros (id, user_id, fornecedor_id)
values ('85300000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000002', '85100000-0000-4000-8000-000000000001');

select is(
    (select infracoes from public.verificar_integridade_baseline() where tabela = 'titulos_financeiros -> fornecedores'),
    1::bigint,
    'Funcao de integridade detecta com precisao a presenca de violacao cross-tenant'
);

-- 4. Testar restrição de acesso da função (anon/authenticated não podem executar)
set local role anon;
select throws_ok(
    'select * from public.verificar_integridade_baseline()',
    '42501',
    null,
    'Role anon e impedida de executar a funcao verificar_integridade_baseline'
);

select * from finish();
rollback;
