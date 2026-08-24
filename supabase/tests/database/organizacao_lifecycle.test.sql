-- ============================================================================
-- organizacao_lifecycle.test.sql
-- Testes pgTAP para o Ticket 39: Implementar suspensão, retenção e encerramento
-- ============================================================================

begin;

select plan(7);

-- Inserir usuários de teste
insert into auth.users (id, email)
values ('96000000-0000-4000-8000-000000000001', 'owner-lifecycle@orbita.test'),
       ('96000000-0000-4000-8000-000000000002', 'stranger-lifecycle@orbita.test')
on conflict do nothing;

\ir .generated/20_organizacao_membership_ativa.inc
\ir .generated/33_planos_limites_entitlements.inc
\ir .generated/34_integrar_stripe_assinaturas.inc
\ir .generated/35_suspensao_retencao_encerramento.inc

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
grant execute on function public.suspender_organizacao(uuid, text, uuid) to service_role;
grant execute on function public.reativar_organizacao(uuid, text, uuid) to service_role;

-- 1. Tabelas e Colunas
select has_table('public', 'historico_ciclo_vida_organizacao', 'Tabela historico_ciclo_vida_organizacao existe');
select has_column('public', 'organizacoes', 'status', 'Coluna status existe em organizacoes');
select has_column('public', 'organizacoes', 'suspenso_em', 'Coluna suspenso_em existe em organizacoes');

-- Setup: Criar Org A com Owner 1
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Lifecycle Test', 'org-lifecycle-test-39') as org_id;

reset role;

-- 2. Suspender Organização
select lives_ok(
    $$select public.suspender_organizacao((select org_id from temp_org_a), 'Inadimplencia Stripe', '96000000-0000-4000-8000-000000000001'::uuid)$$,
    'RPC suspender_organizacao executa com sucesso'
);

select is(
    (select status from public.organizacoes where id = (select org_id from temp_org_a)),
    'suspended',
    'Status da organizacao atualizado para suspended'
);

-- 3. Reativar Organização
select lives_ok(
    $$select public.reativar_organizacao((select org_id from temp_org_a), 'Pagamento regularizado', '96000000-0000-4000-8000-000000000001'::uuid)$$,
    'RPC reativar_organizacao executa com sucesso'
);

select is(
    (select status from public.organizacoes where id = (select org_id from temp_org_a)),
    'active',
    'Status da organizacao restaurado para active'
);

select * from finish();
rollback;
