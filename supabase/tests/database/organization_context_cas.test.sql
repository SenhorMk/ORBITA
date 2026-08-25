begin;

select plan(8);

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/38_contexto_organizacao_ativo_cas.sql

insert into auth.users (id, email)
values
  ('98000000-0000-4000-8000-000000000001', 'context-a@orbita.test'),
  ('98000000-0000-4000-8000-000000000002', 'context-b@orbita.test')
on conflict do nothing;

insert into public.organizacoes (id, nome, slug)
values
  ('98100000-0000-4000-8000-000000000001', 'Context Org A', 'context-org-a'),
  ('98100000-0000-4000-8000-000000000002', 'Context Org B', 'context-org-b')
on conflict do nothing;

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values
  ('98100000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 'owner'),
  ('98100000-0000-4000-8000-000000000002', '98000000-0000-4000-8000-000000000001', 'member')
on conflict do nothing;

select is(
  (select aplicado from public.alternar_organizacao_ativa_cas(
    '98000000-0000-4000-8000-000000000001',
    '98100000-0000-4000-8000-000000000001', 0)),
  true,
  'initial compare-and-swap persists version one'
);

select is(
  (select aplicado from public.alternar_organizacao_ativa_cas(
    '98000000-0000-4000-8000-000000000001',
    '98100000-0000-4000-8000-000000000002', 0)),
  false,
  'replaying the initial version loses'
);

select is(
  (select versao from public.alternar_organizacao_ativa_cas(
    '98000000-0000-4000-8000-000000000001',
    '98100000-0000-4000-8000-000000000002', 1)),
  2::bigint,
  'the current version changes organization and increments atomically'
);

select is(
  (select aplicado from public.alternar_organizacao_ativa_cas(
    '98000000-0000-4000-8000-000000000001',
    '98100000-0000-4000-8000-000000000001', 1)),
  false,
  'a concurrent loser cannot reuse the consumed version'
);

select is(
  (select organizacao_id from public.contextos_organizacao_ativos
   where user_id = '98000000-0000-4000-8000-000000000001'),
  '98100000-0000-4000-8000-000000000002'::uuid,
  'a stale switch does not overwrite the winning organization'
);

select throws_ok(
  $$select * from public.alternar_organizacao_ativa_cas(
    '98000000-0000-4000-8000-000000000002',
    '98100000-0000-4000-8000-000000000001', 0)$$,
  '42501', null,
  'a foreign user cannot select another tenant organization'
);

delete from public.membros_organizacao
where user_id = '98000000-0000-4000-8000-000000000001'
  and organizacao_id = '98100000-0000-4000-8000-000000000002';

select throws_ok(
  $$select * from public.alternar_organizacao_ativa_cas(
    '98000000-0000-4000-8000-000000000001',
    '98100000-0000-4000-8000-000000000002', 2)$$,
  '42501', null,
  'a revoked membership cannot be selected'
);

select is(
  (select count(*) from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name = 'alternar_organizacao_ativa_cas'
     and grantee in ('anon', 'authenticated')),
  0::bigint,
  'browser roles cannot call the service-only switch function'
);

select * from finish();
rollback;
