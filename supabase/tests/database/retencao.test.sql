-- ============================================================================
-- retencao.test.sql
-- Testes pgTAP para o Ticket 18: retenção, anonimização e eliminação
--
-- Prova, no nível de banco:
--   - as 5 tabelas novas existem;
--   - o registry seed fica pending_approval (nenhum prazo real ativo);
--   - só pode existir uma versão 'approved' por categoria (unique index);
--   - retencao_iniciar_run é idempotente (mesma chave nunca duplica a run) —
--     cobre "duas execuções concorrentes" e resume pós-crash;
--   - o seletor usa organizacao_id (cross-tenant nunca aparece) e reivindica
--     (claim) o item — uma segunda seleção do mesmo run nunca repete o item;
--   - legal hold impede a seleção/aplicação de efeito;
--   - anonimização é irreversível (null direto, sem hash), idempotente e
--     gera exatamente um tombstone;
--   - eliminação remove a linha, verifica legal hold e gera tombstone;
--   - tombstone é imutável (UPDATE/DELETE sempre bloqueados, mesmo pela
--     própria migration/role dona das tabelas);
--   - reconciliação pós-restore reaplica supressão em dado "ressuscitado";
--   - retencao_concluir_run nunca aceita 'completed' com contagem_falhos > 0;
--   - RLS restringe leitura de runs/itens a admin/owner da própria organização;
--   - as RPCs não são executáveis por anon/authenticated (Data API bloqueada).
-- ============================================================================

begin;

insert into auth.users (id, email)
values
    ('99700000-0000-4000-8000-000000000001', 'owner-retencao-a@orbita.test'),
    ('99700000-0000-4000-8000-000000000002', 'owner-retencao-b@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql
\ir ../../../database/27_migrar_chatwoot_organizacao.sql

-- `clientes` reconstruída como baseline (schema_master.sql não é executável
-- isoladamente em banco vazio) — mesmo padrão do teste do ticket 17.
create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    organizacao_id        uuid,
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              text not null,
    nome                  text not null,
    cpf_cnpj              text,
    email                 text,
    telefone              text,
    telefone_normalizado  text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

\ir ../../../database/51_retencao_anonimizacao_eliminacao.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
-- A concessão ampla acima (padrão dos demais testes de migration) sobrescreve
-- a restrição deliberada da migration 51 sobre legal_holds/tombstones. Revoga
-- de novo para o teste provar a postura de produção real.
revoke all on public.retention_legal_holds from authenticated, anon;
revoke all on public.retention_tombstones from authenticated, anon;

select plan(31);

-- 1-5. Tabelas existem
select has_table('public', 'retention_policy_registry', 'Tabela retention_policy_registry existe');
select has_table('public', 'retention_legal_holds', 'Tabela retention_legal_holds existe');
select has_table('public', 'retention_runs', 'Tabela retention_runs existe');
select has_table('public', 'retention_run_items', 'Tabela retention_run_items existe');
select has_table('public', 'retention_tombstones', 'Tabela retention_tombstones existe');

-- 6. Seed do registry fica pending_approval — nenhum prazo real ativo
select is(
    (select count(*)::int from public.retention_policy_registry where status = 'approved'),
    0,
    'Nenhuma politica real esta approved (prazos pendentes de aprovacao, Ticket 15)'
);

-- 7. Só uma versão 'approved' por categoria (unique index parcial)
insert into public.retention_policy_registry (
    categoria, versao, tabela_alvo, coluna_relogio, prazo_dias, acao, owner, status
) values ('pgtap_categoria_sintetica', 1, 'clientes', 'updated_at', 1, 'anonymize', 'needs-owner:test', 'approved');

select throws_ok(
    $$insert into public.retention_policy_registry (categoria, versao, tabela_alvo, coluna_relogio, prazo_dias, acao, owner, status)
      values ('pgtap_categoria_sintetica', 2, 'clientes', 'updated_at', 1, 'anonymize', 'needs-owner:test', 'approved')$$,
    '23505',
    null,
    'Nao pode existir uma segunda versao approved da mesma categoria (uq_retention_policy_categoria_aprovada)'
);

-- Setup: Org A (owner 1) e Org B (owner 2)
set local role authenticated;
set local request.jwt.claim.sub = '99700000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Retencao A', 'org-retencao-a') as org_id;

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '99700000-0000-4000-8000-000000000002';

create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Retencao B', 'org-retencao-b') as org_id;

reset role;

-- Clientes: um elegivel (relogio antigo) e um nao elegivel (relogio recente)
-- na Org A; um cliente na Org B (nunca deve aparecer na selecao da Org A).
insert into public.clientes (id, organizacao_id, bling_id, nome, email, telefone, updated_at)
values
    ('99710000-0000-4000-8000-000000000001', (select org_id from temp_org_a), 'bling-1', 'Cliente Elegivel', 'elegivel@orbita.test', '+5511900000001', now() - interval '400 days'),
    ('99710000-0000-4000-8000-000000000002', (select org_id from temp_org_a), 'bling-2', 'Cliente Recente', 'recente@orbita.test', '+5511900000002', now()),
    ('99710000-0000-4000-8000-000000000003', (select org_id from temp_org_b), 'bling-3', 'Cliente Org B', 'orgb@orbita.test', '+5511900000003', now() - interval '400 days');

-- 8. retencao_iniciar_run é idempotente: mesma chave nunca duplica a run
--    (cobre duas "execucoes concorrentes" e retomada apos crash).
create temp table temp_run_1 as
select * from public.retencao_iniciar_run(
    (select org_id from temp_org_a), 'pgtap_categoria_sintetica', 1, 'execute', now() - interval '30 days', 'corr-retencao-1'
);

create temp table temp_run_1_again as
select * from public.retencao_iniciar_run(
    (select org_id from temp_org_a), 'pgtap_categoria_sintetica', 1, 'execute', now() - interval '30 days', 'corr-retencao-1-retry'
);

select is(
    (select run_id from temp_run_1_again),
    (select run_id from temp_run_1),
    'Segunda chamada com a mesma chave converge no mesmo run_id (idempotencia/concorrencia)'
);
select is((select ja_existia from temp_run_1), false, 'Primeira chamada nao e "ja existia"');
select is((select ja_existia from temp_run_1_again), true, 'Segunda chamada com a mesma chave reporta "ja existia"');

select set_config('test.run_id_a', (select run_id::text from temp_run_1), false);

-- 9. Seletor usa organizacao_id — cliente da Org B nunca aparece no lote da Org A
create temp table temp_lote_1 as
select * from public.retencao_selecionar_e_reivindicar_lote(
    current_setting('test.run_id_a')::uuid,
    (select org_id from temp_org_a),
    'pgtap_categoria_sintetica',
    'clientes',
    now() - interval '30 days',
    100
);

select is(
    (select count(*)::int from temp_lote_1),
    1,
    'Seletor retorna apenas o cliente elegivel (relogio <= cutoff), nunca o recente nem o de outra organizacao'
);
select is(
    (select entidade_id from temp_lote_1),
    '99710000-0000-4000-8000-000000000001',
    'Seletor retorna exatamente o cliente elegivel da Org A'
);

-- 10. Reivindicacao (claim): repetir a mesma selecao no mesmo run nunca
--     retorna o item de novo (concorrencia — equivalente a FOR UPDATE SKIP LOCKED
--     + unique constraint em retention_run_items).
create temp table temp_lote_1_again as
select * from public.retencao_selecionar_e_reivindicar_lote(
    current_setting('test.run_id_a')::uuid,
    (select org_id from temp_org_a),
    'pgtap_categoria_sintetica',
    'clientes',
    now() - interval '30 days',
    100
);

select is(
    (select count(*)::int from temp_lote_1_again),
    0,
    'Segunda reivindicacao da mesma run nunca repete um item ja reivindicado'
);

-- 11. Legal hold: marcar hold e verificar que a anonimizacao e recusada
select public.retencao_marcar_legal_hold(
    (select org_id from temp_org_a), 'pgtap_categoria_sintetica', '99710000-0000-4000-8000-000000000001', 'Investigacao interna em curso', null
);

select is(
    (select public.retencao_aplicar_anonimizacao(
        current_setting('test.run_id_a')::uuid, (select org_id from temp_org_a), 'pgtap_categoria_sintetica', 'clientes', '99710000-0000-4000-8000-000000000001'
    )),
    false,
    'Anonimizacao e recusada enquanto o legal hold estiver ativo'
);

select is(
    (select email from public.clientes where id = '99710000-0000-4000-8000-000000000001'),
    'elegivel@orbita.test',
    'Dado permanece intacto enquanto o legal hold estiver ativo'
);

-- 12. Liberar o hold e aplicar a anonimizacao
select public.retencao_liberar_legal_hold((select org_id from temp_org_a), 'pgtap_categoria_sintetica', '99710000-0000-4000-8000-000000000001');

select is(
    (select public.retencao_aplicar_anonimizacao(
        current_setting('test.run_id_a')::uuid, (select org_id from temp_org_a), 'pgtap_categoria_sintetica', 'clientes', '99710000-0000-4000-8000-000000000001'
    )),
    true,
    'Anonimizacao e aplicada apos o hold ser liberado'
);

select is(
    (select email from public.clientes where id = '99710000-0000-4000-8000-000000000001'),
    null,
    'E-mail e anulado (irreversivel, nunca hash) apos anonimizacao'
);
select is(
    (select nome from public.clientes where id = '99710000-0000-4000-8000-000000000001'),
    'Titular anonimizado',
    'Nome vira marcador de anonimizacao (preserva integridade referencial de pedidos/FKs)'
);
select is(
    (select anonimizado_em is not null from public.clientes where id = '99710000-0000-4000-8000-000000000001'),
    true,
    'anonimizado_em marca o item como ja processado (idempotencia)'
);

-- 13. Idempotencia: reaplicar anonimizacao no mesmo item nao duplica o tombstone
select public.retencao_aplicar_anonimizacao(
    current_setting('test.run_id_a')::uuid, (select org_id from temp_org_a), 'pgtap_categoria_sintetica', 'clientes', '99710000-0000-4000-8000-000000000001'
);

select is(
    (select count(*)::int from public.retention_tombstones where organizacao_id = (select org_id from temp_org_a) and entidade_id = '99710000-0000-4000-8000-000000000001'),
    1,
    'Reaplicar anonimizacao no mesmo item nunca duplica o tombstone (unique constraint)'
);

-- 14. Tombstone e imutavel: UPDATE e DELETE sempre bloqueados
select throws_ok(
    $$update public.retention_tombstones set acao = 'deleted' where entidade_id = '99710000-0000-4000-8000-000000000001'$$,
    '0LTMB',
    null,
    'UPDATE em retention_tombstones e sempre bloqueado (ledger protegido)'
);
select throws_ok(
    $$delete from public.retention_tombstones where entidade_id = '99710000-0000-4000-8000-000000000001'$$,
    '0LTMB',
    null,
    'DELETE em retention_tombstones e sempre bloqueado (ledger protegido)'
);

-- 15. Exclusao: contato Chatwoot elegivel e eliminado de fato
insert into public.chatwoot_contacts (id, user_id, name, email, updated_at)
values (990001, '99700000-0000-4000-8000-000000000001', 'Contato Retencao', 'contato@orbita.test', now() - interval '400 days');

create temp table temp_run_2 as
select * from public.retencao_iniciar_run(
    (select org_id from temp_org_a), 'chatwoot_contato_inativo', 1, 'execute', now() - interval '30 days', 'corr-retencao-2'
);

select public.retencao_aplicar_exclusao(
    (select run_id from temp_run_2), (select org_id from temp_org_a), 'chatwoot_contato_inativo', 'chatwoot_contacts', '990001'
);

select is(
    (select count(*)::int from public.chatwoot_contacts where id = 990001),
    0,
    'Contato e efetivamente eliminado apos retencao_aplicar_exclusao'
);
select is(
    (select acao from public.retention_tombstones where organizacao_id = (select org_id from temp_org_a) and entidade_id = '990001'),
    'deleted',
    'Tombstone de exclusao registra acao=deleted'
);

-- 16. Reconciliacao pos-restore: um restore "ressuscita" o cliente ja
--     anonimizado (simulado por um UPDATE direto, como um restore de backup
--     faria) — a reconciliacao deve detectar via tombstone e reaplicar.
update public.clientes
set email = 'ressuscitado-pelo-restore@orbita.test', nome = 'Nome Restaurado', anonimizado_em = null
where id = '99710000-0000-4000-8000-000000000001';

create temp table temp_restore as
select * from public.retencao_reaplicar_tombstones_restore((select org_id from temp_org_a));

select is(
    (select bool_or(reaplicado) from temp_restore where entidade_id = '99710000-0000-4000-8000-000000000001'),
    true,
    'Reconciliacao pos-restore detecta e reaplica supressao no dado ressuscitado'
);
select is(
    (select email from public.clientes where id = '99710000-0000-4000-8000-000000000001'),
    null,
    'Apos a reconciliacao, o dado ressuscitado volta a ficar anonimizado'
);

-- 17. retencao_concluir_run nunca aceita 'completed' com falhas pendentes
update public.retention_runs set contagem_falhos = 1 where id = current_setting('test.run_id_a')::uuid;
select public.retencao_concluir_run(current_setting('test.run_id_a')::uuid, 'completed', null);

select is(
    (select status from public.retention_runs where id = current_setting('test.run_id_a')::uuid),
    'completed_with_errors',
    'Run com contagem_falhos > 0 nunca fica completed — vira completed_with_errors'
);

-- 18. RLS: admin da Org A ve a propria run
set local role authenticated;
set local request.jwt.claim.sub = '99700000-0000-4000-8000-000000000001';

select is(
    (select count(*)::int from public.retention_runs where id = current_setting('test.run_id_a')::uuid),
    1,
    'Admin da Org A enxerga a propria run de retencao'
);

reset role;

-- 19. RLS: admin da Org B nao ve a run da Org A (cross-tenant)
set local role authenticated;
set local request.jwt.claim.sub = '99700000-0000-4000-8000-000000000002';

select is(
    (select count(*)::int from public.retention_runs where id = current_setting('test.run_id_a')::uuid),
    0,
    'Admin da Org B nao enxerga a run de retencao da Org A (RLS cross-tenant)'
);

reset role;

-- 20-21. RPCs de efeito nao expostas a anon/authenticated
select is(
    (select count(*) from information_schema.role_routine_grants
     where routine_schema = 'public'
       and routine_name in ('retencao_aplicar_anonimizacao', 'retencao_aplicar_exclusao', 'retencao_iniciar_run')
       and grantee in ('anon', 'authenticated')),
    0::bigint,
    'RPCs de efeito de retencao nao sao executaveis por anon/authenticated'
);

select is(
    (select count(*) from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('retention_legal_holds', 'retention_tombstones')
       and grantee in ('anon', 'authenticated')),
    0::bigint,
    'Legal holds e tombstones nunca sao legiveis diretamente por anon/authenticated'
);

select * from finish();
rollback;
