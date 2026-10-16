-- eventos_de_auditoria_do_catalogo.test.sql
-- Migration 79 (PRE-006B): os cinco eventos do cadastro de produto e da
-- sincronização de categorias existem no catálogo SQL com a forma do catálogo
-- TypeScript; `registrar_evento_auditoria` grava para um ator membro e recusa
-- o ator de outra organização e o chamador `authenticated`.

begin;

select plan(5);

insert into auth.users (id, email)
values
    ('79000000-0000-4000-8000-000000000001', 'owner-a-t79@orbita.test'),
    ('79000000-0000-4000-8000-000000000002', 'owner-b-t79@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/36_auditoria_correlacao_telemetria.sql
\ir ../../../database/37_fechar_rpcs_grants_perigosos.sql
\ir ../../../database/52_auditoria_anti_forjamento_catalogo.sql
\ir ../../../database/79_eventos_de_auditoria_do_catalogo.sql

grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated, service_role;

select is(
    (select count(*)::int from public.catalogo_eventos_auditoria
      where produtor = 'catalog' and ator_esperado = 'user' and retention_dias = 730
        and (nome, severidade) in (
            ('catalog.product_saved', 'info'),
            ('catalog.product_save_rejected', 'info'),
            ('catalog.product_reconcile_required', 'critical'),
            ('catalog.categories_synced', 'info'),
            ('catalog.categories_sync_failed', 'warning'))),
    5,
    '1. os cinco eventos do catálogo estão no catálogo SQL, com a forma do catálogo TypeScript'
);

set local role authenticated;
set local request.jwt.claim.sub = '79000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
create temp table temp_org_a_t79 as
select public.criar_organizacao_atomica('Org A T79', 'org-a-t79') as org_id;
set local request.jwt.claim.sub = '79000000-0000-4000-8000-000000000002';
create temp table temp_org_b_t79 as
select public.criar_organizacao_atomica('Org B T79', 'org-b-t79') as org_id;
reset role;
grant select on temp_org_a_t79, temp_org_b_t79 to service_role, authenticated;

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select ok(
    public.registrar_evento_auditoria(
        (select org_id from temp_org_a_t79),
        '79000000-0000-4000-8000-000000000001'::uuid,
        'catalog.product_saved',
        'produto',
        '79300000-0000-4000-8000-00000000000a',
        'corr_t79',
        null,
        null,
        '{"produto_id": "79300000-0000-4000-8000-00000000000a", "bling_id": "4242", "operacao": "cadastro", "saldo": "aplicado"}'::jsonb
    ) is not null,
    '2. a RPC existente grava o produto salvo para um ator membro'
);

select ok(
    public.registrar_evento_auditoria(
        (select org_id from temp_org_a_t79),
        '79000000-0000-4000-8000-000000000001'::uuid,
        'catalog.categories_sync_failed',
        'categorias',
        null,
        'corr_t79_cat',
        null,
        null,
        '{"categorias_gravadas": 100}'::jsonb
    ) is not null,
    '3. a falha parcial da sincronização de categorias é registrável sem recurso_id'
);

select throws_ok(
    $$ select public.registrar_evento_auditoria(
        (select org_id from temp_org_a_t79),
        '79000000-0000-4000-8000-000000000002'::uuid,
        'catalog.product_reconcile_required',
        'produto', null, 'corr_t79_x', null, null,
        '{"operacao": "cadastro", "motivo": "bling_sem_confirmacao", "bling_id": null}'::jsonb) $$,
    null,
    null,
    '4. o dono da organização B não grava evento de catálogo na organização A'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '79000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select throws_ok(
    $$ select public.registrar_evento_auditoria(
        (select org_id from temp_org_a_t79),
        '79000000-0000-4000-8000-000000000001'::uuid,
        'catalog.product_saved',
        'produto', null, 'corr_t79_y', null, null, '{}'::jsonb) $$,
    null,
    null,
    '5. o navegador (authenticated) não produz auditoria de catálogo como autoridade'
);

reset role;

select * from finish();
rollback;
