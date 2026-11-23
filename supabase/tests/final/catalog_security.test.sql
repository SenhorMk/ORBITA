begin;

select plan(15);

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
    with expected(signature) as (values
      ('public.usuario_pertence_a_organizacao(uuid)'),
      ('public.criar_organizacao_atomica(text,text)'),
      ('public.criar_convite_organizacao(uuid,text,text,text)'),
      ('public.aceitar_convite_organizacao(text)'),
      ('public.revogar_membro_organizacao(uuid,uuid)'),
      ('public.obter_entitlements_organizacao(uuid)'),
      ('public.usuario_tem_papel_na_organizacao(uuid,text,uuid)'),
      ('public.agendar_encerramento_organizacao(uuid,text,integer,uuid)'),
      ('public.cancelar_agendamento_encerramento(uuid,uuid)'),
      ('public.sac_publicar_politica_resolucao(uuid,text,text,text,timestamptz,text,text,text,text)')
    ), actual as (
      select p.oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ), expected_oids as (
      select to_regprocedure(signature)::oid as oid from expected
    )
    select (select count(*) from (select oid from actual except select oid from expected_oids) extras)
         + (select count(*) from (select oid from expected_oids except select oid from actual) missing)
  ),
  0::bigint,
  'authenticated EXECUTE grants exactly match the reviewed signature allowlist'
);

select is(
  (
    with expected(signature) as (values
      ('public.registrar_evento_inbox_bling(uuid,uuid,uuid,text,text,jsonb)'),
      ('public.concluir_evento_inbox_bling(uuid,text,jsonb,text)'),
      ('public.preparar_replay_evento_inbox_bling(uuid)'),
      ('public.registrar_evento_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,jsonb)'),
      ('public.concluir_evento_inbox_chatwoot(uuid,text,jsonb,text)'),
      ('public.preparar_replay_evento_inbox_chatwoot(uuid)'),
      ('public.registrar_job_sync(uuid,uuid)'),
      ('public.registrar_evento_outbox(uuid,uuid,uuid,text,text,text,jsonb,integer)'),
      ('public.atualizar_saude_conexao(uuid,text,text)'),
      ('public.registrar_evento_auditoria(uuid,uuid,text,text,text,text,text,text,jsonb)')
    )
    select count(*)
    from expected
    where to_regprocedure(signature) is null
       or not has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE')
  ),
  0::bigint,
  'service role retains every reviewed infrastructure RPC signature'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public' and r.rolname <> 'postgres'
  ),
  0::bigint,
  'all application functions have the expected owner'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'usuario_tem_papel_na_organizacao',
        'agendar_encerramento_organizacao',
        'cancelar_agendamento_encerramento'
      ])
      and array_position(coalesce(p.proconfig, array[]::text[]), 'search_path=""') is not null
  ),
  3::bigint,
  'Ticket 05 security-definer functions use an empty search path'
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
