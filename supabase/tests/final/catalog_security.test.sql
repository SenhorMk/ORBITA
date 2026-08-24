begin;

select plan(11);

select ok(
  to_regclass('public.organizacoes') is not null,
  'final catalog contains the organization tenancy root'
);

select ok(
  to_regclass('public.stripe_webhook_events') is not null,
  'final catalog contains the Stripe idempotency inbox'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and r.rolname <> 'postgres'
  ),
  0::bigint,
  'all application relations have the expected owner'
);

select is(
  (
    select count(distinct c.oid)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and a.attnum > 0
      and not a.attisdropped
      and a.attname in ('user_id', 'organizacao_id')
      and not c.relrowsecurity
  ),
  0::bigint,
  'every tenant-keyed application table enables RLS'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not c.relrowsecurity
      and (
        has_table_privilege('anon', c.oid, 'INSERT')
        or has_table_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE')
        or has_table_privilege('anon', c.oid, 'TRUNCATE')
      )
  ),
  0::bigint,
  'anonymous role has no direct write privilege on application tables'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not c.relrowsecurity
      and (
        has_table_privilege('authenticated', c.oid, 'INSERT')
        or has_table_privilege('authenticated', c.oid, 'UPDATE')
        or has_table_privilege('authenticated', c.oid, 'DELETE')
        or has_table_privilege('authenticated', c.oid, 'TRUNCATE')
      )
  ),
  0::bigint,
  'every table writable by the authenticated browser role is protected by RLS'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  0::bigint,
  'anonymous role cannot execute application functions'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.proacl is null
  ),
  0::bigint,
  'browser-executable functions depend on explicit grants, never implicit PUBLIC execution'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) setting
        where setting like 'search_path=%'
      )
  ),
  0::bigint,
  'every security-definer function pins its search path'
);

select ok(
  to_regclass('public.idx_membros_org_user') is not null,
  'membership user lookups have their canonical index'
);

select ok(
  to_regclass('public.uq_idx_assinaturas_stripe_subscription') is not null,
  'Stripe subscription identity is protected by a unique index'
);

select * from finish();
rollback;
