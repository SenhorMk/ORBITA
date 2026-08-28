-- ============================================================================
-- titular_direitos.test.sql
-- Testes pgTAP para o Ticket 17: Implementar direitos do titular (LGPD)
--
-- Prova, no nível de banco:
--   - as 5 tabelas novas existem;
--   - registrar_solicitacao_titular é idempotente (pedido repetido);
--   - aplicar_transicao_solicitacao_titular usa CAS por versão (nunca aplica
--     com versão desatualizada) e nunca aplica fora do organizacao_id correto
--     (isolamento cross-tenant no nível de RPC, não só de RLS);
--   - toda transição grava uma linha de histórico append-only;
--   - uma tarefa "retained_with_reason" exige fundamento (constraint);
--   - RLS restringe leitura de solicitação a admin/owner da própria organização;
--   - as RPCs não são executáveis por anon/authenticated (Data API bloqueada).
-- ============================================================================

begin;

insert into auth.users (id, email)
values
    ('99500000-0000-4000-8000-000000000001', 'owner-titular-a@orbita.test'),
    ('99500000-0000-4000-8000-000000000002', 'owner-titular-b@orbita.test'),
    ('99500000-0000-4000-8000-000000000003', 'impostor-titular@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql
\ir ../../../database/28_inbox_idempotente_bling.sql
\ir ../../../database/29_inbox_idempotente_chatwoot.sql
\ir ../../../database/30_jobs_sync_duraveis.sql
\ir ../../../database/31_outbox_retries_saude_integracoes.sql
\ir ../../../database/48_outbox_lease_correlacao.sql

-- `clientes` reconstruída como baseline (schema_master.sql não é executável
-- isoladamente em banco vazio) — mesmo padrão usado pelos demais testes de
-- migration que precisam da tabela base do domínio comercial.
create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              text not null,
    nome                  text not null,
    cpf_cnpj              text,
    email                 text,
    telefone              text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

\ir ../../../database/50_titular_direitos.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
-- A concessao ampla acima (padrao usado pelos demais testes de migration,
-- necessaria para os proprios passos deste teste poderem operar como
-- 'authenticated') sobrescreveria a restricao deliberada da migration 50
-- sobre titular_solicitacao_verificacoes (nunca legivel por
-- anon/authenticated). Revoga de novo, explicitamente, para o teste provar
-- a postura de producao real, nao a conveniencia do harness.
revoke all on public.titular_solicitacao_verificacoes from authenticated, anon;

select plan(24);

-- 1-5. Tabelas existem
select has_table('public', 'titular_solicitacoes', 'Tabela titular_solicitacoes existe');
select has_table('public', 'titular_solicitacao_verificacoes', 'Tabela titular_solicitacao_verificacoes existe');
select has_table('public', 'titular_solicitacao_tarefas', 'Tabela titular_solicitacao_tarefas existe');
select has_table('public', 'titular_solicitacao_historico', 'Tabela titular_solicitacao_historico existe');
select has_table('public', 'titular_exportacoes', 'Tabela titular_exportacoes existe');

-- Setup: Org A (owner 1) e Org B (owner 2)
set local role authenticated;
set local request.jwt.claim.sub = '99500000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Titular A', 'org-titular-a') as org_id;

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '99500000-0000-4000-8000-000000000002';

create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Titular B', 'org-titular-b') as org_id;

reset role;

insert into public.clientes (id, bling_id, nome, email)
values ('99600000-0000-4000-8000-000000000001', 'bling-cliente-1', 'Cliente Final Teste', 'cliente@orbita.test');

-- 6. Registrar solicitação (cliente_final, tipo acesso) para Org A
create temp table temp_req_1 as
select * from public.registrar_solicitacao_titular(
    (select org_id from temp_org_a),
    'cliente_final',
    null,
    '99600000-0000-4000-8000-000000000001'::uuid,
    null,
    'acesso',
    'web',
    now() + interval '15 days',
    'idem-cliente-1-acesso-2026w01',
    'corr-titular-1',
    '{}'::jsonb
);

select is((select estado from temp_req_1), 'received', 'Nova solicitacao comeca em received');
select is((select versao from temp_req_1), 0, 'Nova solicitacao comeca na versao 0');

-- Guarda o id em um GUC de sessao: tabelas temp (pg_temp) nao sao visiveis a
-- outra role sem GRANT explicito, e os passos de RLS abaixo trocam a role
-- para 'authenticated' — um GUC de sessao permanece legivel independente de
-- role, sem precisar conceder privilegios extras sobre a tabela temporaria.
select set_config('test.solicitacao_titular_id', (select solicitacao_id::text from temp_req_1), false);
select is((select is_duplicate from temp_req_1), false, 'Primeira chamada nao e duplicada');

-- 7. Pedido repetido (mesma idempotency_key) é idempotente: mesma linha, is_duplicate=true
create temp table temp_req_1_dup as
select * from public.registrar_solicitacao_titular(
    (select org_id from temp_org_a),
    'cliente_final',
    null,
    '99600000-0000-4000-8000-000000000001'::uuid,
    null,
    'acesso',
    'web',
    now() + interval '15 days',
    'idem-cliente-1-acesso-2026w01',
    'corr-titular-1-retry',
    '{}'::jsonb
);

select is(
    (select solicitacao_id from temp_req_1_dup),
    (select solicitacao_id from temp_req_1),
    'Pedido repetido (mesma idempotency_key) resolve para a mesma solicitacao'
);
select is((select is_duplicate from temp_req_1_dup), true, 'Pedido repetido e marcado como duplicado');

-- 8. Total de solicitacoes ainda e 1 (nao duplicou linha)
select is(
    (select count(*)::int from public.titular_solicitacoes where organizacao_id = (select org_id from temp_org_a)),
    1,
    'Pedido repetido nao cria uma segunda linha de solicitacao'
);

-- 9. Transicao valida via CAS: received -> identity_pending
create temp table temp_t1 as
select * from public.aplicar_transicao_solicitacao_titular(
    (select solicitacao_id from temp_req_1),
    (select org_id from temp_org_a),
    0,
    'identity_pending',
    null,
    null,
    'corr-titular-1',
    '{}'::jsonb
);

select is((select aplicado from temp_t1), true, 'Transicao CAS com versao correta e aplicada');
select is((select versao_atual from temp_t1), 1, 'Versao incrementa apos transicao aplicada');

-- 10. CAS com versao desatualizada e rejeitado (nao aplica, nao regride)
create temp table temp_t2 as
select * from public.aplicar_transicao_solicitacao_titular(
    (select solicitacao_id from temp_req_1),
    (select org_id from temp_org_a),
    0, -- versao ja obsoleta (atual e 1)
    'verified',
    null,
    null,
    'corr-titular-1-stale',
    '{}'::jsonb
);

select is((select aplicado from temp_t2), false, 'Transicao CAS com versao desatualizada e rejeitada');
select is((select estado_atual from temp_t2), 'identity_pending', 'Estado permanece identity_pending apos CAS rejeitado');

-- 11. Cross-tenant: Org B tenta transicionar solicitacao de Org A -> rejeitado
create temp table temp_t3 as
select * from public.aplicar_transicao_solicitacao_titular(
    (select solicitacao_id from temp_req_1),
    (select org_id from temp_org_b),
    1,
    'verified',
    null,
    null,
    'corr-titular-cross-tenant',
    '{}'::jsonb
);

select is((select aplicado from temp_t3), false, 'Organizacao B nao consegue transicionar solicitacao da Organizacao A');

-- 12. Cada transicao aplicada grava uma linha de historico (append-only)
select is(
    (select count(*)::int from public.titular_solicitacao_historico where solicitacao_id = (select solicitacao_id from temp_req_1)),
    2, -- received (no registro inicial) + identity_pending
    'Historico contem uma linha por transicao aplicada (received + identity_pending)'
);

-- 13. Tarefa retained_with_reason exige fundamento (constraint de banco)
select throws_ok(
    format(
        $$insert into public.titular_solicitacao_tarefas (solicitacao_id, sistema, status, fundamento) values (%L, 'stripe', 'retained_with_reason', null)$$,
        (select solicitacao_id from temp_req_1)
    ),
    '23514',
    null,
    'Tarefa retained_with_reason sem fundamento viola constraint chk_fundamento_quando_retido'
);

-- 14. registrar_tarefa_solicitacao_titular é idempotente por (solicitacao, sistema): upsert
select public.registrar_tarefa_solicitacao_titular((select solicitacao_id from temp_req_1), 'banco', 'completed', null, null, null);
select public.registrar_tarefa_solicitacao_titular((select solicitacao_id from temp_req_1), 'banco', 'completed', null, null, null);

select is(
    (select count(*)::int from public.titular_solicitacao_tarefas where solicitacao_id = (select solicitacao_id from temp_req_1) and sistema = 'banco'),
    1,
    'Upsert de tarefa por sistema nunca duplica a linha (unique solicitacao_id+sistema)'
);

-- 15. RLS: admin da Org A ve a propria solicitacao
set local role authenticated;
set local request.jwt.claim.sub = '99500000-0000-4000-8000-000000000001';

select is(
    (select count(*)::int from public.titular_solicitacoes where id = current_setting('test.solicitacao_titular_id')::uuid),
    1,
    'Admin da Org A enxerga a solicitacao da propria organizacao'
);

reset role;

-- 16. RLS: admin da Org B (impostor cross-tenant) NAO ve a solicitacao da Org A
set local role authenticated;
set local request.jwt.claim.sub = '99500000-0000-4000-8000-000000000002';

select is(
    (select count(*)::int from public.titular_solicitacoes where id = current_setting('test.solicitacao_titular_id')::uuid),
    0,
    'Admin da Org B nao enxerga solicitacao da Org A (RLS cross-tenant)'
);

reset role;

-- 17. RLS: usuario sem nenhum membership (impostor) nao ve nenhuma solicitacao
set local role authenticated;
set local request.jwt.claim.sub = '99500000-0000-4000-8000-000000000003';

select is(
    (select count(*)::int from public.titular_solicitacoes),
    0,
    'Usuario sem membership nao enxerga nenhuma solicitacao de titular'
);

reset role;

-- 18-19. RPCs nao expostas a anon/authenticated
select is(
    (select count(*) from information_schema.role_routine_grants
     where routine_schema = 'public'
       and routine_name in ('registrar_solicitacao_titular', 'aplicar_transicao_solicitacao_titular', 'registrar_tarefa_solicitacao_titular')
       and grantee in ('anon', 'authenticated')),
    0::bigint,
    'RPCs de solicitacao do titular nao sao executaveis por anon/authenticated'
);

-- 20. Verificacoes de identidade nunca sao legiveis por authenticated (contem hash de codigo)
select is(
    (select count(*) from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = 'titular_solicitacao_verificacoes'
       and grantee in ('anon', 'authenticated')),
    0::bigint,
    'Tabela de verificacoes nunca e legivel diretamente por anon/authenticated'
);

select * from finish();
rollback;
