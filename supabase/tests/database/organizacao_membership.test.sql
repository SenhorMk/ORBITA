-- organizacao_membership.test.sql
-- Ticket 24: Criar organização, membership e organização ativa

begin;

insert into auth.users (id, email)
values ('95000000-0000-4000-8000-000000000001', 'owner-org@orbita.test'),
       ('95000000-0000-4000-8000-000000000002', 'stranger-org@orbita.test');

\ir .generated/20_organizacao_membership_ativa.inc

select plan(6);

-- 1. Testar que anon não pode criar organização
set local role anon;
select throws_ok(
    $$select public.criar_organizacao_atomica('Empresa XYZ', 'empresa-xyz')$$,
    '42501',
    null,
    'Usuario anonimo e impedido de criar organizacao'
);

-- 2. Testar criação atômica autenticada (cria org + owner membership)
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000001';

create temp table temp_org_result as
select public.criar_organizacao_atomica('Acme Corp', 'acme-corp') as org_id;

select is(
    (select count(*) from public.organizacoes where slug = 'acme-corp'),
    1::bigint,
    'Organizacao foi inserida com sucesso'
);

select is(
    (select papel from public.membros_organizacao where user_id = '95000000-0000-4000-8000-000000000001'::uuid),
    'owner',
    'Criador foi associado atomicamente como owner da organizacao'
);

-- 3. Testar RLS: Membro consegue visualizar sua organização
select is(
    (select count(*) from public.organizacoes where id = (select org_id from temp_org_result)),
    1::bigint,
    'Membro autenticado visualiza sua organizacao via RLS'
);

-- 4. Testar RLS: Usuário externo NÃO consegue visualizar organização alheia
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000002';

select is(
    (select count(*) from public.organizacoes where id = (select org_id from temp_org_result)),
    0::bigint,
    'Usuario de outro tenant nao consegue visualizar organizacao alheia via RLS'
);

select is(
    (select count(*) from public.membros_organizacao where organizacao_id = (select org_id from temp_org_result)),
    0::bigint,
    'Usuario de outro tenant nao consegue visualizar memberships de organizacao alheia via RLS'
);

select * from finish();
rollback;
