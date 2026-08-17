begin;

create table public.produtos (
    id uuid primary key,
    user_id uuid not null,
    estoque integer not null
);

-- Minimal contracts required by the canonical RPC definitions. The test owns
-- only disposable fixtures; production DDL remains in database/.
create table public.pedidos (
    id uuid primary key,
    user_id uuid not null,
    total numeric not null default 0,
    status text not null default 'Pendente',
    data timestamptz not null default now()
);

create table public.integracoes_bling (
    user_id uuid primary key,
    refresh_locked_at timestamptz
);

insert into public.produtos (id, user_id, estoque)
values
    ('60000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', 10),
    ('60000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', 10);

grant all privileges on public.produtos to anon, authenticated, service_role;

create function public.decrement_estoque(p_produto_id uuid, p_qty integer)
returns void
language plpgsql
as $$
begin
    update public.produtos
    set estoque = greatest(0, estoque - p_qty)
    where id = p_produto_id;
end;
$$;

create function public.acquire_bling_token_lock(p_user_id uuid, p_timeout_seconds integer default 30)
returns boolean
language sql
security definer
as $$ select true $$;

grant execute on function public.decrement_estoque(uuid, integer) to public, anon, authenticated, service_role;
grant execute on function public.acquire_bling_token_lock(uuid, integer) to public, anon, authenticated, service_role;

\ir .generated/09_harden_grants_and_rpcs.inc

create table public.ticket06_future_table (id bigint primary key);
create function public.ticket06_future_function()
returns boolean
language sql
as $$ select true $$;

select plan(22);

select ok(
    not has_table_privilege('anon', 'public.produtos', 'select'),
    'anonymous role cannot read domain tables'
);
select ok(
    has_table_privilege('authenticated', 'public.produtos', 'select'),
    'authenticated browser keeps the required product read capability'
);
select ok(
    not has_table_privilege('authenticated', 'public.produtos', 'insert'),
    'authenticated browser cannot insert domain rows directly'
);
select ok(
    not has_table_privilege('authenticated', 'public.produtos', 'delete'),
    'authenticated browser cannot delete domain rows directly'
);
select ok(
    not has_table_privilege('authenticated', 'public.produtos', 'truncate'),
    'authenticated browser cannot truncate domain tables'
);
select ok(
    not has_table_privilege('authenticated', 'public.produtos', 'trigger'),
    'authenticated browser cannot create domain triggers'
);
select is(
    to_regprocedure('public.decrement_estoque(uuid,integer)'),
    null::regprocedure,
    'the unscoped stock mutation signature is removed'
);
select ok(
    not coalesce(has_function_privilege(
        'anon',
        to_regprocedure('public.decrement_estoque(uuid,uuid,integer)'),
        'execute'
    ), false),
    'anonymous role cannot execute the scoped stock mutation'
);
select ok(
    not coalesce(has_function_privilege(
        'authenticated',
        to_regprocedure('public.decrement_estoque(uuid,uuid,integer)'),
        'execute'
    ), false),
    'authenticated browser cannot execute the scoped stock mutation'
);
select ok(
    coalesce(has_function_privilege(
        'service_role',
        to_regprocedure('public.decrement_estoque(uuid,uuid,integer)'),
        'execute'
    ), false),
    'service role can execute the scoped stock mutation'
);
select ok(
    not coalesce((
        select prosecdef
        from pg_proc
        where oid = to_regprocedure('public.acquire_bling_token_lock(uuid,integer)')
    ), true),
    'Bling token lock executes with invoker privileges'
);
select is(
    (
        select proconfig
        from pg_proc
        where oid = to_regprocedure('public.acquire_bling_token_lock(uuid,integer)')
    ),
    array['search_path=""']::text[],
    'Bling token lock resolves every object from an empty search path'
);
select ok(
    not has_function_privilege(
        'anon',
        'public.acquire_bling_token_lock(uuid,integer)',
        'execute'
    ),
    'anonymous role cannot execute the privileged Bling lock'
);
select ok(
    not has_function_privilege(
        'authenticated',
        'public.acquire_bling_token_lock(uuid,integer)',
        'execute'
    ),
    'authenticated browser cannot execute the privileged Bling lock'
);

set local role anon;
select throws_ok(
    $$select public.decrement_estoque(
        '61000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        1
    )$$,
    '42501',
    'permission denied for function decrement_estoque',
    'anonymous execution is denied by PostgreSQL'
);
reset role;

set local role authenticated;
select throws_ok(
    $$select public.decrement_estoque(
        '61000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        1
    )$$,
    '42501',
    'permission denied for function decrement_estoque',
    'authenticated browser execution is denied by PostgreSQL'
);
reset role;

set local role service_role;
select throws_ok(
    $$select public.decrement_estoque(
        '61000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000002',
        3
    )$$,
    'P0002',
    'Produto não encontrado para o tenant.',
    'service mutation rejects a product from another tenant'
);
select lives_ok(
    $$select public.decrement_estoque(
        '61000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        3
    )$$,
    'service mutation accepts a product from the verified tenant'
);
select is(
    (
        select estoque
        from public.produtos
        where id = '60000000-0000-4000-8000-000000000001'
    ),
    7,
    'authorized service mutation changes only the owned product'
);
reset role;

select ok(
    not has_table_privilege('anon', 'public.ticket06_future_table', 'select')
    and not has_table_privilege('authenticated', 'public.ticket06_future_table', 'select'),
    'future tables are not exposed to browser roles by default'
);
select ok(
    not has_function_privilege('anon', 'public.ticket06_future_function()', 'execute')
    and not has_function_privilege('authenticated', 'public.ticket06_future_function()', 'execute'),
    'future functions are not exposed to browser roles by default'
);
select ok(
    not exists (
        select 1
        from pg_proc
        where pronamespace = 'public'::regnamespace
          and prosecdef
          and (
              has_function_privilege('anon', oid, 'execute')
              or has_function_privilege('authenticated', oid, 'execute')
          )
    ),
    'no security-definer function is executable by browser roles'
);

select * from finish();
rollback;
