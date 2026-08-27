-- ============================================================================
-- outbox_lease_correlacao.test.sql
-- Testes pgTAP para o Ticket 12: lease owner/expiração no outbox + correlation_id
--
-- Prova, no nível de banco, as invariantes que a auditoria
-- (docs/migrations/ticket-12-durability-audit.md) identificou como ausentes:
--   - dois workers não podem reivindicar o mesmo evento (exclusão mútua real
--     via FOR UPDATE SKIP LOCKED, observada pela transição de estado);
--   - concluir um evento exige posse do lease vigente — um worker "zumbi"
--     (lease expirado ou de outro dono) nunca aplica o efeito duas vezes;
--   - lease expirado é recuperável pelo reaper sem perder o evento e sem
--     reiniciar a contagem de tentativas (max_attempts é respeitado);
--   - correlation_id sobrevive ao ciclo claim -> complete.
-- ============================================================================

begin;

insert into auth.users (id, email)
values ('97000000-0000-4000-8000-000000000001', 'owner-outbox-lease@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql
\ir ../../../database/28_inbox_idempotente_bling.sql
\ir ../../../database/29_inbox_idempotente_chatwoot.sql
\ir ../../../database/30_jobs_sync_duraveis.sql
\ir ../../../database/31_outbox_retries_saude_integracoes.sql
\ir ../../../database/48_outbox_lease_correlacao.sql

select plan(15);

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Outbox Lease A', 'org-outbox-lease-a') as org_id;

reset role;

-- 1-3. Colunas novas existem
select has_column('public', 'outbox_eventos', 'lease_owner', 'Coluna lease_owner existe em outbox_eventos');
select has_column('public', 'outbox_eventos', 'lease_expires_at', 'Coluna lease_expires_at existe em outbox_eventos');
select has_column('public', 'outbox_eventos', 'correlation_id', 'Coluna correlation_id existe em outbox_eventos');

-- 4. Registrar evento com correlation_id
create temp table temp_evt_1 as
select * from public.registrar_evento_outbox(
    (select org_id from temp_org_a),
    null,
    '97000000-0000-4000-8000-000000000001'::uuid,
    'msg_send_lease_101',
    'chatwoot',
    'message.send',
    '{"content": "Teste lease"}'::jsonb,
    3
);

update public.outbox_eventos
set correlation_id = 'corr_teste_lease_101'
where id = (select evento_id from temp_evt_1);

-- 5. Worker A reivindica o lote e recebe lease_owner = worker-a + correlation_id preservado
create temp table temp_claim_a as
select * from public.reivindicar_lote_outbox('worker-a', 10, 300);

select is(
    (select lease_owner from temp_claim_a where evento_id = (select evento_id from temp_evt_1)),
    'worker-a',
    'Worker A reivindica o evento e recebe o lease_owner correto'
);

select is(
    (select correlation_id from temp_claim_a where evento_id = (select evento_id from temp_evt_1)),
    'corr_teste_lease_101',
    'correlation_id persiste ao ser reivindicado pelo worker'
);

-- 6. Worker B tenta reivindicar o mesmo lote: o evento já está 'processing',
--    não é mais elegível (status in pending/failed_transient) — exclusão mútua
--    provada pela transição de estado que o FOR UPDATE SKIP LOCKED protege.
create temp table temp_claim_b as
select * from public.reivindicar_lote_outbox('worker-b', 10, 300);

select is(
    (select count(*)::int from temp_claim_b where evento_id = (select evento_id from temp_evt_1)),
    0,
    'Worker B não consegue reivindicar evento já sob lease de worker-a'
);

-- 7. Worker B (impostor) tenta concluir o evento sem possuir o lease: rejeitado
select is(
    public.concluir_evento_outbox((select evento_id from temp_evt_1), 'worker-b', 'sent', '{"ok": true}'::jsonb),
    false,
    'concluir_evento_outbox rejeita worker sem posse do lease vigente'
);

-- 8. Estado permanece 'processing' após a tentativa rejeitada (nenhum efeito duplicado)
select is(
    (select status from public.outbox_eventos where id = (select evento_id from temp_evt_1)),
    'processing',
    'Evento permanece processing após conclusão rejeitada por posse de lease inválida'
);

-- 9. Worker A (dono legítimo do lease) conclui com sucesso
select is(
    public.concluir_evento_outbox((select evento_id from temp_evt_1), 'worker-a', 'sent', '{"ok": true}'::jsonb),
    true,
    'concluir_evento_outbox aceita o dono legítimo do lease vigente'
);

select is(
    (select status from public.outbox_eventos where id = (select evento_id from temp_evt_1)),
    'sent',
    'Evento concluído pelo dono do lease é marcado sent'
);

-- 10. Segunda organização/evento para testar reaper de lease expirado
create temp table temp_evt_2 as
select * from public.registrar_evento_outbox(
    (select org_id from temp_org_a),
    null,
    '97000000-0000-4000-8000-000000000001'::uuid,
    'msg_send_lease_202',
    'chatwoot',
    'message.send',
    '{"content": "Teste reaper"}'::jsonb,
    2
);

create temp table temp_claim_2 as
select * from public.reivindicar_lote_outbox('worker-crash', 10, 300);

-- Simula crash: força lease_expires_at para o passado (worker nunca voltou)
update public.outbox_eventos
set lease_expires_at = now() - interval '1 minute'
where id = (select evento_id from temp_evt_2);

-- 11. Reaper libera o lease expirado e conta como uma tentativa consumida
create temp table temp_reaper as
select * from public.liberar_leases_expirados_outbox();

select is(
    (select novo_status from temp_reaper where evento_id = (select evento_id from temp_evt_2)),
    'failed_transient',
    'Reaper devolve evento com lease expirado para failed_transient (ainda tem tentativas)'
);

select is(
    (select attempts from public.outbox_eventos where id = (select evento_id from temp_evt_2)),
    1,
    'Reaper contabiliza a tentativa perdida no crash (attempts = 1)'
);

-- 12. Worker zumbi (worker-crash) não consegue mais concluir após o reaper agir
select is(
    public.concluir_evento_outbox((select evento_id from temp_evt_2), 'worker-crash', 'sent', '{"ok": true}'::jsonb),
    false,
    'Worker zumbi não pode concluir evento após reaper liberar o lease'
);

-- 13. Evento voltou a ser elegível para reivindicação (crash recovery real)
create temp table temp_claim_recovered as
select * from public.reivindicar_lote_outbox('worker-recovered', 10, 300);

select is(
    (select lease_owner from temp_claim_recovered where evento_id = (select evento_id from temp_evt_2)),
    'worker-recovered',
    'Evento recuperado pelo reaper é reivindicável por um novo worker'
);

-- 14. Grants: função de claim/complete/reaper não expostas a anon/authenticated
select is(
    (select count(*) from information_schema.role_routine_grants
     where routine_schema = 'public'
       and routine_name in ('reivindicar_lote_outbox', 'liberar_leases_expirados_outbox')
       and grantee in ('anon', 'authenticated')),
    0::bigint,
    'RPCs de claim/reaper do outbox não são executáveis por anon/authenticated'
);

select * from finish();
rollback;
