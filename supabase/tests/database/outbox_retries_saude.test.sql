-- ============================================================================
-- outbox_retries_saude.test.sql
-- Testes pgTAP para o Ticket 35: Outbox, retries e saúde das integrações
-- ============================================================================

begin;

insert into auth.users (id, email)
values ('99000000-0000-4000-8000-000000000001', 'owner-outbox@orbita.test'),
       ('99000000-0000-4000-8000-000000000002', 'other-outbox@orbita.test');

\ir .generated/20_organizacao_membership_ativa.inc
\ir .generated/25_conexoes_credenciais_privadas.inc
\ir .generated/31_outbox_retries_saude_integracoes.inc

select plan(8);

-- Setup: Criar Org A
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Outbox A', 'org-outbox-a') as org_id;

reset role;

-- 1. Tabela outbox_eventos existe
select has_table('public', 'outbox_eventos', 'Tabela public.outbox_eventos existe');

-- 2. Colunas de saúde em conexoes_integracao existem
select has_column('public', 'conexoes_integracao', 'health_status', 'Coluna health_status existe em conexoes_integracao');
select has_column('public', 'conexoes_integracao', 'last_health_check_at', 'Coluna last_health_check_at existe em conexoes_integracao');

-- 3. Registrar evento no outbox (primeira inserção)
create temp table temp_evt_1 as
select * from public.registrar_evento_outbox(
    (select org_id from temp_org_a),
    null,
    '99000000-0000-4000-8000-000000000001'::uuid,
    'msg_send_101',
    'chatwoot',
    'message.send',
    '{"content": "Teste pgTAP"}'::jsonb,
    5
);

select is(
    (select is_duplicate from temp_evt_1),
    false,
    'Primeiro registro de evento no outbox retorna is_duplicate = false'
);

-- 4. Registro duplicado com mesma chave retorna is_duplicate = true
create temp table temp_evt_dup as
select * from public.registrar_evento_outbox(
    (select org_id from temp_org_a),
    null,
    '99000000-0000-4000-8000-000000000001'::uuid,
    'msg_send_101',
    'chatwoot',
    'message.send',
    '{"content": "Teste pgTAP"}'::jsonb,
    5
);

select is(
    (select is_duplicate from temp_evt_dup),
    true,
    'Registro duplicado de evento no outbox retorna is_duplicate = true'
);

-- 5. Reivindicar lote do outbox (status transita para processing)
create temp table temp_claimed as
select * from public.reivindicar_lote_outbox(10);

select isnt_empty(
    $$ select * from temp_claimed where evento_id = (select evento_id from temp_evt_1) $$,
    'Evento pendente é reivindicado no lote'
);

-- 6. Concluir evento como sent
select lives_ok(
    $$ select public.concluir_evento_outbox((select evento_id from temp_evt_1), 'sent', '{"status": "ok"}'::jsonb) $$,
    'Concluir evento como sent executa sem erros'
);

-- 7. Verificar status 'sent' persistido
select is(
    (select status from public.outbox_eventos where id = (select evento_id from temp_evt_1)),
    'sent',
    'Status do evento no outbox foi atualizado para sent'
);

select * from finish();
rollback;
