-- ============================================================================
-- jobs_sync_duraveis.test.sql
-- Testes pgTAP para o Ticket 34: Executar sincronizações como jobs duráveis
-- ============================================================================

begin;

insert into auth.users (id, email)
values ('98000000-0000-4000-8000-000000000001', 'owner-sync-jobs@orbita.test'),
       ('98000000-0000-4000-8000-000000000002', 'other-sync-jobs@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/30_jobs_sync_duraveis.sql

select plan(8);

-- Setup: Criar Org A e Org B
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Sync Jobs A', 'org-sync-jobs-a') as org_id;

set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000002';
create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Sync Jobs B', 'org-sync-jobs-b') as org_id;

reset role;

-- 1. Tabela sync_jobs existe
select has_table('public', 'sync_jobs', 'Tabela public.sync_jobs existe');

-- 2. Colunas essenciais existem
select has_column('public', 'sync_jobs', 'status', 'Coluna status existe em sync_jobs');
select has_column('public', 'sync_jobs', 'lease_expires_at', 'Coluna lease_expires_at existe em sync_jobs');
select has_column('public', 'sync_jobs', 'progress', 'Coluna progress existe em sync_jobs');

-- 3. Registrar job (is_new = true)
create temp table temp_job_1 as
select * from public.registrar_job_sync(
    (select org_id from temp_org_a),
    '98000000-0000-4000-8000-000000000001'::uuid
);

select is(
    (select is_new from temp_job_1),
    true,
    'Primeiro registro de job de sync retorna is_new = true'
);

-- 4. Registrar segundo job com anterior ainda ativo retorna job existente (is_new = false)
create temp table temp_job_dup as
select * from public.registrar_job_sync(
    (select org_id from temp_org_a),
    '98000000-0000-4000-8000-000000000001'::uuid
);

select is(
    (select is_new from temp_job_dup),
    false,
    'Segundo registro de job com job ativo retorna is_new = false (idempotência)'
);

-- 5. Adquirir lease exclusivo
select is(
    public.adquirir_lease_job_sync((select job_id from temp_job_1), 10),
    true,
    'Adquirir lease do job retorna true'
);

-- 6. Concluir job
select lives_ok(
    $$ select public.concluir_job_sync((select job_id from temp_job_1), 'completed') $$,
    'Concluir job executa sem erros'
);

select * from finish();
rollback;
