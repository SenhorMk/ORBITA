-- eventos_de_auditoria_da_foto_do_produto.test.sql
-- Migration 71: os dois eventos da foto do produto existem no catálogo SQL, e
-- `registrar_evento_auditoria` grava um deles para um ator membro.

begin;

select plan(2);

insert into auth.users (id, email)
values ('71000000-0000-4000-8000-000000000001', 'owner-t71@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/36_auditoria_correlacao_telemetria.sql
\ir ../../../database/37_fechar_rpcs_grants_perigosos.sql
\ir ../../../database/52_auditoria_anti_forjamento_catalogo.sql
\ir ../../../database/71_eventos_de_auditoria_da_foto_do_produto.sql

grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated, service_role;

select is(
    (select count(*)::int from public.catalogo_eventos_auditoria
      where nome in ('catalog.product_image_uploaded', 'catalog.product_image_removed')
        and produtor = 'catalog' and severidade = 'info' and ator_esperado = 'user' and retention_dias = 730),
    2,
    '1. os dois eventos da foto estão no catálogo SQL, com a forma do catálogo TypeScript'
);

set local role authenticated;
set local request.jwt.claim.sub = '71000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
create temp table temp_org_t71 as
select public.criar_organizacao_atomica('Org T71', 'org-t71') as org_id;
reset role;
grant select on temp_org_t71 to service_role;

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select ok(
    public.registrar_evento_auditoria(
        (select org_id from temp_org_t71),
        '71000000-0000-4000-8000-000000000001'::uuid,
        'catalog.product_image_uploaded',
        'produto',
        '71300000-0000-4000-8000-00000000000a',
        'corr_t71',
        null,
        null,
        '{"produto_id": "71300000-0000-4000-8000-00000000000a", "substituiu_anterior": false, "limpeza_anterior": "nao_aplicavel"}'::jsonb
    ) is not null,
    '2. a RPC existente grava o evento novo para um ator membro'
);

reset role;

select * from finish();
rollback;
