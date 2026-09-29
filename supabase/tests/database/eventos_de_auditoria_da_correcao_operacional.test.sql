-- eventos_de_auditoria_da_correcao_operacional.test.sql
-- Migration 69: os cinco eventos da correção operacional existem no catálogo
-- SQL, e `registrar_evento_auditoria` grava um deles para um ator membro.

begin;

select plan(3);

insert into auth.users (id, email)
values ('69000000-0000-4000-8000-000000000001', 'owner-t69@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/36_auditoria_correlacao_telemetria.sql
\ir ../../../database/37_fechar_rpcs_grants_perigosos.sql
\ir ../../../database/52_auditoria_anti_forjamento_catalogo.sql
\ir ../../../database/69_eventos_de_auditoria_da_correcao_operacional.sql

grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated, service_role;

select is(
    (select count(*)::int from public.catalogo_eventos_auditoria where nome in (
        'customer.contact_deleted',
        'customer.contact_reconcile_required',
        'finance.entry_deleted',
        'finance.expense_cancelled',
        'finance.remote_reconcile_required'
    )),
    5,
    '1. os cinco eventos da correção operacional estão no catálogo SQL'
);

select is(
    -- `auth.password_reset_requested` é redefinição de senha, não reset de dados.
    (select count(*)::int from public.catalogo_eventos_auditoria where nome ~ '^(org|customer|finance)\..*reset'),
    0,
    '2. nenhum evento de reset de dados'
);

set local role authenticated;
set local request.jwt.claim.sub = '69000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
create temp table temp_org_t69 as
select public.criar_organizacao_atomica('Org T69', 'org-t69') as org_id;
reset role;
grant select on temp_org_t69 to service_role;

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select ok(
    public.registrar_evento_auditoria(
        (select org_id from temp_org_t69),
        '69000000-0000-4000-8000-000000000001'::uuid,
        'finance.expense_cancelled',
        'titulo_financeiro',
        '69300000-0000-4000-8000-00000000000a',
        'corr_t69',
        null,
        null,
        '{"bling_id": "123", "evidencia": "exclusao_confirmada"}'::jsonb
    ) is not null,
    '3. a RPC existente grava o evento novo para um ator membro'
);

reset role;

select * from finish();
rollback;
