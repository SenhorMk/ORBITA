begin;

select plan(16);

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/39_endurecer_identidade_sessao_oauth.sql

insert into auth.users (id, email)
values
  ('99000000-0000-4000-8000-000000000001', 'oauth-actor-a@orbita.test'),
  ('99000000-0000-4000-8000-000000000002', 'oauth-actor-b@orbita.test')
on conflict do nothing;

insert into public.organizacoes (id, nome, slug)
values
  ('99100000-0000-4000-8000-000000000001', 'OAuth Org A', 'oauth-org-a')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- transacoes_oauth: single-use CAS consumption
-- ---------------------------------------------------------------------------

insert into public.transacoes_oauth (id, actor_id, organizacao_id, provedor, state_hash, criado_em, expira_em)
values (
  '99200000-0000-4000-8000-000000000001',
  '99000000-0000-4000-8000-000000000001',
  '99100000-0000-4000-8000-000000000001',
  'bling',
  'hash-valid-state',
  now(),
  now() + interval '10 minutes'
);

select is(
  (select consumido from public.consumir_transacao_oauth(
    '99200000-0000-4000-8000-000000000001', 'hash-valid-state', now())),
  true,
  'first consumption of a valid, unexpired transaction succeeds'
);

select is(
  (select actor_id from public.consumir_transacao_oauth(
    '99200000-0000-4000-8000-000000000001', 'hash-valid-state', now())),
  null::uuid,
  'a second consumption attempt (replay) returns no actor'
);

select is(
  (select consumido from public.consumir_transacao_oauth(
    '99200000-0000-4000-8000-000000000001', 'hash-valid-state', now())),
  false,
  'replaying an already-consumed transaction is denied without a new effect'
);

select is(
  (select count(*)::int from public.transacoes_oauth
   where id = '99200000-0000-4000-8000-000000000001' and consumido_em is not null),
  1,
  'the transaction was consumed exactly once, not mutated again by the replay'
);

insert into public.transacoes_oauth (id, actor_id, organizacao_id, provedor, state_hash, criado_em, expira_em)
values (
  '99200000-0000-4000-8000-000000000002',
  '99000000-0000-4000-8000-000000000001',
  '99100000-0000-4000-8000-000000000001',
  'bling',
  'hash-expired-state',
  now() - interval '11 minutes',
  now() - interval '1 minute'
);

select is(
  (select consumido from public.consumir_transacao_oauth(
    '99200000-0000-4000-8000-000000000002', 'hash-expired-state', now())),
  false,
  'an expired transaction cannot be consumed'
);

insert into public.transacoes_oauth (id, actor_id, organizacao_id, provedor, state_hash, criado_em, expira_em)
values (
  '99200000-0000-4000-8000-000000000003',
  '99000000-0000-4000-8000-000000000001',
  '99100000-0000-4000-8000-000000000001',
  'bling',
  'hash-mismatch-state',
  now(),
  now() + interval '10 minutes'
);

select is(
  (select consumido from public.consumir_transacao_oauth(
    '99200000-0000-4000-8000-000000000003', 'wrong-hash', now())),
  false,
  'a mismatched state hash is denied'
);

select is(
  (select count(*)::int from public.transacoes_oauth
   where id = '99200000-0000-4000-8000-000000000003' and consumido_em is not null),
  0,
  'a denied mismatched-hash attempt leaves the transaction available for the real caller'
);

select is(
  (select actor_id from public.consumir_transacao_oauth(
    '99200000-0000-4000-8000-000000000003', 'hash-mismatch-state', now())),
  '99000000-0000-4000-8000-000000000001'::uuid,
  'the correct hash still consumes the transaction and returns its actor'
);

-- Concurrent-consumption invariant: two sequential CAS attempts against the same
-- row simulate racing callers; exactly one succeeds and no double token exchange
-- can occur because the second call observes consumido_em already set.
insert into public.transacoes_oauth (id, actor_id, organizacao_id, provedor, state_hash, criado_em, expira_em)
values (
  '99200000-0000-4000-8000-000000000004',
  '99000000-0000-4000-8000-000000000002',
  null,
  'bling',
  'hash-race-state',
  now(),
  now() + interval '10 minutes'
);

select is(
  (select count(*)::int from (
    select consumido from public.consumir_transacao_oauth('99200000-0000-4000-8000-000000000004', 'hash-race-state', now())
    union all
    select consumido from public.consumir_transacao_oauth('99200000-0000-4000-8000-000000000004', 'hash-race-state', now())
  ) as attempts where consumido = true),
  1,
  'exactly one of two racing callbacks consumes the transaction'
);

select is(
  (select count(*) from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name = 'consumir_transacao_oauth'
     and grantee in ('anon', 'authenticated')),
  0::bigint,
  'browser roles cannot call the OAuth transaction consumption function'
);

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'transacoes_oauth'
     and grantee in ('anon', 'authenticated')),
  0::bigint,
  'browser roles have no direct grants on the OAuth transaction table'
);

-- ---------------------------------------------------------------------------
-- limite_taxa_tentativas: rate limit sequence permitido -> bloqueado -> expira
-- ---------------------------------------------------------------------------

select is(
  (select permitido from public.registrar_tentativa_limite_taxa(
    'register:203.0.113.10', 2, 60, '2026-01-01T00:00:00Z')),
  true,
  'first attempt within the window is permitted'
);

select is(
  (select permitido from public.registrar_tentativa_limite_taxa(
    'register:203.0.113.10', 2, 60, '2026-01-01T00:00:20Z')),
  true,
  'second attempt within the window is still permitted at the limit'
);

select is(
  (select permitido from public.registrar_tentativa_limite_taxa(
    'register:203.0.113.10', 2, 60, '2026-01-01T00:00:40Z')),
  false,
  'third attempt within the window is blocked once the limit is exceeded'
);

select is(
  (select permitido from public.registrar_tentativa_limite_taxa(
    'register:203.0.113.10', 2, 60, '2026-01-01T00:01:01Z')),
  true,
  'a new attempt after the window elapses is permitted again'
);

select is(
  (select count(*) from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name = 'registrar_tentativa_limite_taxa'
     and grantee in ('anon', 'authenticated')),
  0::bigint,
  'browser roles cannot call the rate limit recording function'
);

select * from finish();
rollback;
