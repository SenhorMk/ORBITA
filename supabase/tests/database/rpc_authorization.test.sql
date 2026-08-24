begin;

select plan(10);

insert into auth.users (id, email)
values
  ('97000000-0000-4000-8000-000000000001', 'owner-rpc-a@orbita.test'),
  ('97000000-0000-4000-8000-000000000002', 'owner-rpc-b@orbita.test'),
  ('97000000-0000-4000-8000-000000000003', 'revoked-rpc@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/34_integrar_stripe_assinaturas.sql
\ir ../../../database/35_suspensao_retencao_encerramento.sql
\ir ../../../database/36_auditoria_correlacao_telemetria.sql
\ir ../../../database/37_fechar_rpcs_grants_perigosos.sql

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
create temp table rpc_org_a as
select public.criar_organizacao_atomica('RPC Org A', 'rpc-org-a') as id;

set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role = 'authenticated';
create temp table rpc_org_b as
select public.criar_organizacao_atomica('RPC Org B', 'rpc-org-b') as id;

grant select on rpc_org_a, rpc_org_b to service_role;

reset role;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select id from rpc_org_a), '97000000-0000-4000-8000-000000000003', 'owner');
delete from public.membros_organizacao
where organizacao_id = (select id from rpc_org_a)
  and user_id = '97000000-0000-4000-8000-000000000003';

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'registrar_evento_inbox_bling', 'concluir_evento_inbox_bling',
        'preparar_replay_evento_inbox_bling', 'registrar_evento_inbox_chatwoot',
        'concluir_evento_inbox_chatwoot', 'preparar_replay_evento_inbox_chatwoot',
        'registrar_job_sync', 'registrar_evento_outbox',
        'atualizar_saude_conexao', 'registrar_evento_auditoria'
      ])
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ),
  0::bigint,
  'authenticated cannot execute infrastructure mutation RPCs'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  0::bigint,
  'anon cannot execute application functions'
);

set local role anon;
select throws_ok(
  $$select public.criar_organizacao_atomica('Anon Org', 'anon-org')$$,
  '42501',
  null,
  'an anonymous caller is denied when it actually invokes a mutating RPC'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000002';

select is(
  public.usuario_tem_papel_na_organizacao(
    (select id from rpc_org_a),
    'owner',
    '97000000-0000-4000-8000-000000000001'
  ),
  false,
  'authenticated cannot forge another actor in the role helper'
);

select throws_ok(
  format(
    'select public.agendar_encerramento_organizacao(%L, %L, 30, %L)',
    (select id from rpc_org_a), 'cross tenant',
    '97000000-0000-4000-8000-000000000001'
  ),
  '42501',
  null,
  'cross-tenant owner cannot schedule deletion by forging the actor'
);

set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000003';
set local request.jwt.claim.role = 'authenticated';
select throws_ok(
  format(
    'select public.agendar_encerramento_organizacao(%L, %L, 30, %L)',
    (select id from rpc_org_a), 'revoked membership',
    '97000000-0000-4000-8000-000000000001'
  ),
  '42501',
  null,
  'a removed membership cannot mutate its former organization'
);

set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
select lives_ok(
  format(
    'select public.agendar_encerramento_organizacao(%L, %L, 30, %L)',
    (select id from rpc_org_a), 'owner request',
    '97000000-0000-4000-8000-000000000002'
  ),
  'valid owner can schedule deletion'
);

reset role;
select is(
  (
    select autor_user_id
    from public.historico_ciclo_vida_organizacao
    where organizacao_id = (select id from rpc_org_a)
      and acao = 'agendamento_encerramento'
    order by created_at desc
    limit 1
  ),
  '97000000-0000-4000-8000-000000000001'::uuid,
  'authenticated lifecycle mutation records auth.uid instead of a supplied actor'
);

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000001';
select throws_ok(
  format(
    'select public.registrar_evento_auditoria(%L, %L, %L, %L)',
    (select id from rpc_org_a),
    '97000000-0000-4000-8000-000000000002',
    'forged.audit', 'organization'
  ),
  '42501',
  null,
  'authenticated cannot forge an audit actor through an infrastructure RPC'
);

reset role;
set local role service_role;
set local request.jwt.claim.role = 'service_role';
select lives_ok(
  format(
    'select public.registrar_evento_auditoria(%L, %L, %L, %L)',
    (select id from rpc_org_a),
    '97000000-0000-4000-8000-000000000001',
    'server.audit', 'organization'
  ),
  'service role can record an event after server-side authorization'
);

select * from finish();
rollback;
