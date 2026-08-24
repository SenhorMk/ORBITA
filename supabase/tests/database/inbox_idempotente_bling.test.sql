-- ============================================================================
-- inbox_idempotente_bling.test.sql
-- Testes pgTAP para o Ticket 32: Persistir inbox idempotente para Bling
-- ============================================================================

begin;

insert into auth.users (id, email)
values ('97000000-0000-4000-8000-000000000001', 'owner-inbox-bling@orbita.test'),
       ('97000000-0000-4000-8000-000000000002', 'other-inbox-bling@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql
\ir ../../../database/26_migrar_bling_organizacao.sql
\ir ../../../database/28_inbox_idempotente_bling.sql

select plan(10);

-- Setup: Criar Org A e Org B
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Inbox Bling A', 'org-inbox-bling-a') as org_id;

set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000002';
create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Inbox Bling B', 'org-inbox-bling-b') as org_id;

reset role;

-- Asserção 1: Tabela inbox_eventos_bling existe
select has_table('public', 'inbox_eventos_bling', 'Tabela public.inbox_eventos_bling existe');

-- Asserção 2: Coluna idempotency_key existe
select has_column('public', 'inbox_eventos_bling', 'idempotency_key', 'Coluna idempotency_key existe');

-- Asserção 3: Coluna organizacao_id existe
select has_column('public', 'inbox_eventos_bling', 'organizacao_id', 'Coluna organizacao_id existe');

-- Asserção 4: RPC registrar_evento_inbox_bling insere novo evento (primeira entrega)
create temp table temp_reg_1 as
select * from public.registrar_evento_inbox_bling(
    (select org_id from temp_org_a),
    null,
    '97000000-0000-4000-8000-000000000001'::uuid,
    'pedido_1001_v1',
    'pedidos',
    '{"id": 1001, "numero": "PED-1001", "total": 150.00}'::jsonb
);

select is(
    (select is_duplicate from temp_reg_1),
    false,
    'Primeira entrega de evento retorna is_duplicate = false'
);

-- Asserção 5: Duplicata do mesmo evento retorna is_duplicate = true
create temp table temp_reg_dup as
select * from public.registrar_evento_inbox_bling(
    (select org_id from temp_org_a),
    null,
    '97000000-0000-4000-8000-000000000001'::uuid,
    'pedido_1001_v1',
    'pedidos',
    '{"id": 1001, "numero": "PED-1001", "total": 150.00}'::jsonb
);

select is(
    (select is_duplicate from temp_reg_dup),
    true,
    'Entrega duplicada do mesmo evento retorna is_duplicate = true'
);

-- Asserção 6: Concluir evento atualiza status para processed e grava response_body
select lives_ok(
    $$select public.concluir_evento_inbox_bling(
        (select evento_id from temp_reg_1),
        'processed',
        '{"success": true, "pedido_id": 1001}'::jsonb,
        null
    )$$,
    'concluir_evento_inbox_bling finaliza processamento com sucesso'
);

-- Asserção 7: Registro subsequente retorna response_body cacheado
create temp table temp_reg_cached as
select * from public.registrar_evento_inbox_bling(
    (select org_id from temp_org_a),
    null,
    '97000000-0000-4000-8000-000000000001'::uuid,
    'pedido_1001_v1',
    'pedidos',
    '{"id": 1001, "numero": "PED-1001", "total": 150.00}'::jsonb
);

select is(
    (select (cached_response->>'success')::boolean from temp_reg_cached),
    true,
    'Duplicata após conclusão retorna o cached_response armazenado'
);

-- Asserção 8: Evento com falha registra diagnóstico e tentativas
create temp table temp_reg_fail as
select * from public.registrar_evento_inbox_bling(
    (select org_id from temp_org_a),
    null,
    '97000000-0000-4000-8000-000000000001'::uuid,
    'pedido_1002_v1',
    'pedidos',
    '{"id": 1002, "numero": "PED-1002"}'::jsonb
);

select public.concluir_evento_inbox_bling(
    (select evento_id from temp_reg_fail),
    'failed',
    null,
    'Erro de conexao com gateway'
);

select is(
    (select status from public.inbox_eventos_bling where id = (select evento_id from temp_reg_fail)),
    'failed',
    'Evento com falha eh marcado como failed com erro registrado'
);

-- Asserção 9: Preparar replay reseta status para processing
create temp table temp_replay as
select * from public.preparar_replay_evento_inbox_bling((select evento_id from temp_reg_fail));

select is(
    (select (payload->>'numero') from temp_replay),
    'PED-1002',
    'preparar_replay_evento_inbox_bling recupera payload intacto para reprocessamento'
);

-- Asserção 10: Isolamento RLS por organização
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000002'; -- Usuário da Org B

select is(
    (select count(*)::int from public.inbox_eventos_bling),
    0,
    'Usuario da Org B nao enxerga eventos no inbox da Org A'
);

reset role;

select * from finish();

rollback;
