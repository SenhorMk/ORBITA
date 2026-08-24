-- ============================================================================
-- planos_entitlements.test.sql
-- Testes pgTAP para o Ticket 37: Criar planos, limites e entitlements
-- ============================================================================

begin;

select plan(9);

-- Inserir usuários de teste
insert into auth.users (id, email)
values ('98000000-0000-4000-8000-000000000001', 'owner-plan@orbita.test'),
       ('98000000-0000-4000-8000-000000000002', 'collab-plan@orbita.test'),
       ('98000000-0000-4000-8000-000000000003', 'stranger-plan@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/33_planos_limites_entitlements.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
grant execute on function public.obter_entitlements_organizacao(uuid) to authenticated, service_role;

-- 1. Tabelas existem
select has_table('public', 'planos', 'Tabela planos existe');
select has_table('public', 'assinaturas_organizacao', 'Tabela assinaturas_organizacao existe');
select has_table('public', 'historico_entitlements', 'Tabela historico_entitlements existe');

-- 2. Planos padrão seedados
select is(
    (select count(*) from public.planos),
    3::bigint,
    'Existem 3 planos padrao seedados (starter, pro, enterprise)'
);

-- Setup: Criar Org A com Owner 1
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Alpha Entitlements', 'org-alpha-entitlements-37') as org_id;

-- Adicionar colaborador 2 na Org A
set local role postgres;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org_a), '98000000-0000-4000-8000-000000000002'::uuid, 'member');

-- Setup Org B para usuário externo 3
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000003';
create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Beta Entitlements', 'org-beta-entitlements-37') as org_id;

reset role;

-- 3. Assinatura criada automaticamente ao criar organização
select is(
    (select count(*) from public.assinaturas_organizacao where organizacao_id = (select org_id from temp_org_a)),
    1::bigint,
    'Assinatura Starter criada automaticamente ao criar organizacao'
);

-- 4. Evento registrado no histórico auditável
select is(
    (select count(*) from public.historico_entitlements where organizacao_id = (select org_id from temp_org_a)),
    1::bigint,
    'Evento de criacao de assinatura registrado no historico auditavel'
);

-- 5. Colaborador da Org A obtém entitlements via RPC
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000002';

select is(
    (select public.obter_entitlements_organizacao((select org_id from temp_org_a))->>'plano_slug'),
    'starter',
    'Colaborador da organizacao obtem entitlements com plano starter via RPC'
);

-- 6. Usuário externo não enxerga assinatura da Org A (RLS)
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000003';

select is(
    (select count(*) from public.assinaturas_organizacao where organizacao_id = (select org_id from temp_org_a)),
    0::bigint,
    'Usuario externo nao enxerga assinatura da Org A via RLS'
);

-- 7. Usuário externo não enxerga histórico da Org A (RLS)
select is(
    (select count(*) from public.historico_entitlements where organizacao_id = (select org_id from temp_org_a)),
    0::bigint,
    'Usuario externo nao enxerga historico de entitlements da Org A via RLS'
);

select * from finish();
rollback;
