-- 09_harden_grants_and_rpcs.sql
-- Forward-only least-privilege migration for browser roles and server RPCs.

-- Existing Data API objects: remove implicit broad access first.
revoke all privileges on all tables in schema public from public, anon, authenticated;
revoke all privileges on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;

-- Future objects created by the two Supabase owner roles start closed.
-- Global defaults must be revoked too: a schema-level REVOKE cannot override
-- a privilege inherited from a global default ACL.
alter default privileges for role postgres
    revoke all privileges on tables from public, anon, authenticated;
alter default privileges for role postgres
    revoke all privileges on sequences from public, anon, authenticated;
alter default privileges for role postgres
    revoke execute on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
    revoke all privileges on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
    revoke all privileges on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
    revoke execute on functions from public, anon, authenticated, service_role;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
        begin
            execute 'alter default privileges for role supabase_admin '
                'revoke all privileges on tables from public, anon, authenticated';
            execute 'alter default privileges for role supabase_admin '
                'revoke all privileges on sequences from public, anon, authenticated';
            execute 'alter default privileges for role supabase_admin '
                'revoke execute on functions from public, anon, authenticated, service_role';
            execute 'alter default privileges for role supabase_admin in schema public '
                'revoke all privileges on tables from public, anon, authenticated';
            execute 'alter default privileges for role supabase_admin in schema public '
                'revoke all privileges on sequences from public, anon, authenticated';
            execute 'alter default privileges for role supabase_admin in schema public '
                'revoke execute on functions from public, anon, authenticated, service_role';
        exception
            when insufficient_privilege then
                -- Supabase intentionally prevents the migration owner from changing
                -- defaults owned by its internal administration role. Application
                -- migrations are owned by postgres and are hardened above; all
                -- existing public objects are still revoked explicitly.
                raise notice 'Skipping supabase_admin default privileges: migration role is not its member';
        end;
    end if;
end;
$$;

-- The browser only reads these current UI projections. RLS remains authoritative.
do $$
declare
    relation_name text;
begin
    foreach relation_name in array array[
        'clientes',
        'produtos',
        'itens_pedido',
        'chatwoot_contacts',
        'chatwoot_conversations',
        'chatwoot_messages'
    ]
    loop
        if to_regclass(format('public.%I', relation_name)) is not null then
            execute format('grant select on table public.%I to authenticated', relation_name);
        end if;
    end loop;
end;
$$;

-- Replace the unscoped stock mutation with an explicitly tenant-scoped contract.
drop function if exists public.decrement_estoque(uuid, integer);

create function public.decrement_estoque(
    p_user_id uuid,
    p_produto_id uuid,
    p_qty integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if p_qty <= 0 then
        raise exception 'Quantidade deve ser maior que zero.' using errcode = '22023';
    end if;

    update public.produtos
    set estoque = greatest(0, estoque - p_qty)
    where id = p_produto_id
      and user_id = p_user_id;

    if not found then
        raise exception 'Produto não encontrado para o tenant.' using errcode = 'P0002';
    end if;
end;
$$;

create or replace function public.dashboard_stats(p_user_id uuid)
returns table (
    faturamento30 numeric,
    total bigint,
    pendentes bigint,
    cancelados bigint,
    atendidos bigint
)
language sql
security invoker
set search_path = ''
as $$
    select
        coalesce(sum(p.total) filter (
            where p.status <> 'Cancelado'
              and p.data >= (pg_catalog.now() - interval '30 days')
        ), 0) as faturamento30,
        count(p.id) as total,
        count(p.id) filter (where p.status = 'Pendente') as pendentes,
        count(p.id) filter (where p.status = 'Cancelado') as cancelados,
        count(p.id) filter (where p.status in ('Atendido', 'Enviado')) as atendidos
    from public.pedidos p
    where p.user_id = p_user_id;
$$;

create or replace function public.try_advisory_lock_sync(p_user_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
    select pg_catalog.pg_try_advisory_lock(
        ('x' || pg_catalog.substr(pg_catalog.md5(p_user_id::text), 1, 16))::bit(64)::bigint
    );
$$;

create or replace function public.advisory_unlock_sync(p_user_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
    select pg_catalog.pg_advisory_unlock(
        ('x' || pg_catalog.substr(pg_catalog.md5(p_user_id::text), 1, 16))::bit(64)::bigint
    );
$$;

create or replace function public.acquire_bling_token_lock(
    p_user_id uuid,
    p_timeout_seconds integer default 30
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_locked_at timestamptz;
    v_now timestamptz := pg_catalog.now();
begin
    if p_timeout_seconds < 5 or p_timeout_seconds > 300 then
        raise exception 'Timeout de lock fora do intervalo permitido.' using errcode = '22023';
    end if;

    select refresh_locked_at
    into v_locked_at
    from public.integracoes_bling
    where user_id = p_user_id
    for update;

    if not found then
        return false;
    end if;

    if v_locked_at is null
       or v_locked_at < v_now - pg_catalog.make_interval(secs => p_timeout_seconds) then
        update public.integracoes_bling
        set refresh_locked_at = v_now
        where user_id = p_user_id;
        return true;
    end if;

    return false;
end;
$$;

drop function if exists public.try_nfe_lock(uuid);
drop function if exists public.unlock_nfe(uuid);

create function public.try_nfe_lock(p_user_id uuid, p_pedido_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if not exists (
        select 1
        from public.pedidos
        where id = p_pedido_id
          and user_id = p_user_id
    ) then
        return false;
    end if;

    return pg_catalog.pg_try_advisory_lock(
        ('x' || pg_catalog.substr(pg_catalog.md5('nfe_' || p_pedido_id::text), 1, 16))::bit(64)::bigint
    );
end;
$$;

create function public.unlock_nfe(p_user_id uuid, p_pedido_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if not exists (
        select 1
        from public.pedidos
        where id = p_pedido_id
          and user_id = p_user_id
    ) then
        return false;
    end if;

    return pg_catalog.pg_advisory_unlock(
        ('x' || pg_catalog.substr(pg_catalog.md5('nfe_' || p_pedido_id::text), 1, 16))::bit(64)::bigint
    );
end;
$$;

-- Retire the unused legacy alias instead of keeping another privileged endpoint.
drop function if exists public.unlock_sync(uuid);

-- CREATE OR REPLACE preserves old ACLs, so close the surface again before grants.
revoke execute on all functions in schema public from public, anon, authenticated, service_role;

grant execute on function public.dashboard_stats(uuid) to service_role;
grant execute on function public.try_advisory_lock_sync(uuid) to service_role;
grant execute on function public.advisory_unlock_sync(uuid) to service_role;
grant execute on function public.acquire_bling_token_lock(uuid, integer) to service_role;
grant execute on function public.decrement_estoque(uuid, uuid, integer) to service_role;
grant execute on function public.try_nfe_lock(uuid, uuid) to service_role;
grant execute on function public.unlock_nfe(uuid, uuid) to service_role;
