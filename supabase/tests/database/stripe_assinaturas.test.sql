-- ============================================================================
-- stripe_assinaturas.test.sql
-- Testes pgTAP para o Ticket 38: Integrar Stripe para assinatura e cobrança
-- ============================================================================

begin;

select plan(8);

-- Inserir usuários de teste
insert into auth.users (id, email)
values ('97000000-0000-4000-8000-000000000001', 'owner-stripe@orbita.test'),
       ('97000000-0000-4000-8000-000000000002', 'stranger-stripe@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/34_integrar_stripe_assinaturas.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
grant execute on function public.obter_entitlements_organizacao(uuid) to authenticated, service_role;
grant execute on function public.atualizar_assinatura_stripe_atomica(uuid, text, text, text, text, text, text, timestamptz, text, jsonb) to service_role;

-- 1. Estrutura e Colunas
select has_table('public', 'stripe_webhook_events', 'Tabela stripe_webhook_events existe');
select has_column('public', 'assinaturas_organizacao', 'stripe_customer_id', 'Coluna stripe_customer_id existe');
select has_column('public', 'assinaturas_organizacao', 'stripe_subscription_id', 'Coluna stripe_subscription_id existe');
select has_column('public', 'assinaturas_organizacao', 'stripe_price_id', 'Coluna stripe_price_id existe');

-- Setup: Criar Org com Owner 1
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Stripe Test', 'org-stripe-test-38') as org_id;

-- 2. Executar RPC de sincronização Stripe como service_role
set local role postgres;

select lives_ok(
    $$select public.atualizar_assinatura_stripe_atomica(
        (select org_id from temp_org_a),
        'pro',
        'active',
        'cus_test_123',
        'sub_test_123',
        'price_pro_month',
        'monthly',
        now() + interval '30 days',
        'Checkout Stripe concluido'
    )$$,
    'RPC atualizar_assinatura_stripe_atomica executa com sucesso'
);

-- 3. Verificar atualização da assinatura para Pro com IDs Stripe
select is(
    (select p.slug from public.assinaturas_organizacao a join public.planos p on p.id = a.plano_id where a.organizacao_id = (select org_id from temp_org_a)),
    'pro',
    'Assinatura atualizada para plano Pro com sucesso'
);

select is(
    (select stripe_customer_id from public.assinaturas_organizacao where organizacao_id = (select org_id from temp_org_a)),
    'cus_test_123',
    'stripe_customer_id salvo corretamente na assinatura'
);

-- 4. Verificar registro no histórico auditável
select is(
    (select evento from public.historico_entitlements where organizacao_id = (select org_id from temp_org_a) and evento = 'upgrade_plano'),
    'upgrade_plano',
    'Historico de entitlements registrou upgrade_plano via Stripe'
);

select * from finish();
rollback;
