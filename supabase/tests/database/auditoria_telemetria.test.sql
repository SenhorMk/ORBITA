-- ============================================================================
-- auditoria_telemetria.test.sql
-- Testes pgTAP para o Ticket 40: Adicionar auditoria, correlação e telemetria
-- ============================================================================

begin;

select plan(9);

-- Inserir usuários de teste
insert into auth.users (id, email)
values ('95000000-0000-4000-8000-000000000001', 'owner-audit-a@orbita.test'),
       ('95000000-0000-4000-8000-000000000002', 'member-audit-a@orbita.test'),
       ('95000000-0000-4000-8000-000000000003', 'owner-audit-b@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/36_auditoria_correlacao_telemetria.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
grant execute on function public.registrar_evento_auditoria(uuid, uuid, text, text, text, text, text, text, jsonb) to authenticated, service_role;

-- 1. Estrutura da Tabela e Colunas
select has_table('public', 'eventos_auditoria_sistema', 'Tabela eventos_auditoria_sistema existe');
select has_column('public', 'eventos_auditoria_sistema', 'organizacao_id', 'Coluna organizacao_id existe');
select has_column('public', 'eventos_auditoria_sistema', 'correlation_id', 'Coluna correlation_id existe');
select has_column('public', 'eventos_auditoria_sistema', 'metadata', 'Coluna metadata existe');

-- Setup: Criar Org A (Owner 1 e Member 2) e Org B (Owner 3)
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000001';
create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Audit A', 'org-audit-a-40') as org_id;

-- Inserir Membro 2 na Org A
reset role;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org_a), '95000000-0000-4000-8000-000000000002'::uuid, 'member');

-- Criar Org B
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000003';
create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Audit B', 'org-audit-b-40') as org_id;

-- 2. Registrar evento de auditoria via RPC
reset role;
create temp table temp_audit_event as
select public.registrar_evento_auditoria(
    (select org_id from temp_org_a),
    '95000000-0000-4000-8000-000000000001'::uuid,
    'integration.connected',
    'bling_connection',
    'conn-12345',
    'corr-abc-999',
    '127.0.0.1',
    'Mozilla/5.0 Test',
    jsonb_build_object('provider', 'bling', 'environment', 'production')
) as event_id;

-- 3. Asserção: Evento registrado no banco
select is(
    (select count(*) from public.eventos_auditoria_sistema where id = (select event_id from temp_audit_event)),
    1::bigint,
    'Evento de auditoria registrado com sucesso'
);

select is(
    (select correlation_id from public.eventos_auditoria_sistema where id = (select event_id from temp_audit_event)),
    'corr-abc-999',
    'Correlation ID persistido corretamente no evento'
);

-- 4. RLS: Owner da Org A consegue visualizar os eventos da sua organização
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000001';

select is(
    (select count(*) from public.eventos_auditoria_sistema where organizacao_id = (select org_id from temp_org_a)),
    1::bigint,
    'Owner da Org A visualiza eventos de auditoria da sua organizacao'
);

-- 5. RLS: Membro comum da Org A NÃO consegue visualizar eventos de auditoria
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000002';

select is(
    (select count(*) from public.eventos_auditoria_sistema where organizacao_id = (select org_id from temp_org_a)),
    0::bigint,
    'Membro comum da Org A nao tem acesso a trilha de auditoria'
);

-- 6. RLS: Owner da Org B NÃO visualiza eventos da Org A (Isolamento Multi-Tenant)
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000003';

select is(
    (select count(*) from public.eventos_auditoria_sistema where organizacao_id = (select org_id from temp_org_a)),
    0::bigint,
    'Owner da Org B isolado dos eventos de auditoria da Org A'
);

select * from finish();
rollback;
