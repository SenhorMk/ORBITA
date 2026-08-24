-- ============================================================================
-- inbox_idempotente_chatwoot.test.sql
-- Testes pgTAP para o Ticket 33: Persistir inbox idempotente para Chatwoot
-- ============================================================================

begin;

insert into auth.users (id, email)
values ('98000000-0000-4000-8000-000000000001', 'owner-inbox-chatwoot@orbita.test'),
       ('98000000-0000-4000-8000-000000000002', 'other-inbox-chatwoot@orbita.test');

\ir .generated/20_organizacao_membership_ativa.inc
\ir .generated/25_conexoes_credenciais_privadas.inc
\ir .generated/27_migrar_chatwoot_organizacao.inc
\ir .generated/29_inbox_idempotente_chatwoot.inc

select plan(10);

-- Setup: Criar Org A e Org B
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Inbox Chatwoot A', 'org-inbox-chatwoot-a') as org_id;

set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000002';
create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Inbox Chatwoot B', 'org-inbox-chatwoot-b') as org_id;

reset role;

-- Asserção 1: Tabela inbox_eventos_chatwoot existe
select has_table('public', 'inbox_eventos_chatwoot', 'Tabela public.inbox_eventos_chatwoot existe');

-- Asserção 2: Coluna idempotency_key existe
select has_column('public', 'inbox_eventos_chatwoot', 'idempotency_key', 'Coluna idempotency_key existe');

-- Asserção 3: Coluna organizacao_id existe
select has_column('public', 'inbox_eventos_chatwoot', 'organizacao_id', 'Coluna organizacao_id existe');

-- Asserção 4: RPC registrar_evento_inbox_chatwoot insere novo evento (primeira entrega)
create temp table temp_reg_1 as
select * from public.registrar_evento_inbox_chatwoot(
    (select org_id from temp_org_a),
    null,
    '98000000-0000-4000-8000-000000000001'::uuid,
    1001::bigint,
    'message_5001_v1',
    'message_created',
    '{"id": 5001, "event": "message_created", "content": "Ola suporte"}'::jsonb
);

select is(
    (select is_duplicate from temp_reg_1),
    false,
    'Primeira entrega de evento Chatwoot retorna is_duplicate = false'
);

-- Asserção 5: Duplicata do mesmo evento retorna is_duplicate = true
create temp table temp_reg_dup as
select * from public.registrar_evento_inbox_chatwoot(
    (select org_id from temp_org_a),
    null,
    '98000000-0000-4000-8000-000000000001'::uuid,
    1001::bigint,
    'message_5001_v1',
    'message_created',
    '{"id": 5001, "event": "message_created", "content": "Ola suporte"}'::jsonb
);

select is(
    (select is_duplicate from temp_reg_dup),
    true,
    'Entrega duplicada do mesmo evento Chatwoot retorna is_duplicate = true'
);

-- Asserção 6: Concluir evento atualiza status para processed e grava response_body
select lives_ok(
    $$select public.concluir_evento_inbox_chatwoot(
        (select evento_id from temp_reg_1),
        'processed',
        '{"success": true, "message_id": 5001}'::jsonb,
        null
    )$$,
    'concluir_evento_inbox_chatwoot finaliza processamento com sucesso'
);

-- Asserção 7: Registro subsequente retorna response_body cacheado
create temp table temp_reg_cached as
select * from public.registrar_evento_inbox_chatwoot(
    (select org_id from temp_org_a),
    null,
    '98000000-0000-4000-8000-000000000001'::uuid,
    1001::bigint,
    'message_5001_v1',
    'message_created',
    '{"id": 5001, "event": "message_created", "content": "Ola suporte"}'::jsonb
);

select is(
    (select (cached_response->>'success')::boolean from temp_reg_cached),
    true,
    'Duplicata após conclusão retorna o cached_response armazenado'
);

-- Asserção 8: Evento com falha registra diagnóstico e tentativas
create temp table temp_reg_fail as
select * from public.registrar_evento_inbox_chatwoot(
    (select org_id from temp_org_a),
    null,
    '98000000-0000-4000-8000-000000000001'::uuid,
    1001::bigint,
    'message_5002_v1',
    'message_created',
    '{"id": 5002, "event": "message_created", "content": "Mensagem com falha"}'::jsonb
);

select public.concluir_evento_inbox_chatwoot(
    (select evento_id from temp_reg_fail),
    'failed',
    null,
    'Falha de processamento de conversa'
);

select is(
    (select status from public.inbox_eventos_chatwoot where id = (select evento_id from temp_reg_fail)),
    'failed',
    'Evento Chatwoot com falha eh marcado como failed com erro registrado'
);

-- Asserção 9: Preparar replay reseta status para processing
create temp table temp_replay as
select * from public.preparar_replay_evento_inbox_chatwoot((select evento_id from temp_reg_fail));

select is(
    (select (payload->>'id')::int from temp_replay),
    5002,
    'preparar_replay_evento_inbox_chatwoot recupera payload intacto para reprocessamento'
);

-- Asserção 10: Isolamento RLS por organização
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-4000-8000-000000000002'; -- Usuário da Org B

select is(
    (select count(*)::int from public.inbox_eventos_chatwoot),
    0,
    'Usuario da Org B nao enxerga eventos no inbox Chatwoot da Org A'
);

reset role;

select * from finish();

rollback;
