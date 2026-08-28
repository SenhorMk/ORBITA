-- ============================================================================
-- auditoria_anti_forjamento.test.sql
-- Testes pgTAP para o Ticket 19: anti-forjamento cross-tenant de auditoria
-- ============================================================================

begin;

select plan(8);

insert into auth.users (id, email)
values ('96000000-0000-4000-8000-000000000001', 'owner-audit19-a@orbita.test'),
       ('96000000-0000-4000-8000-000000000002', 'owner-audit19-b@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/36_auditoria_correlacao_telemetria.sql
\ir ../../../database/37_fechar_rpcs_grants_perigosos.sql
\ir ../../../database/52_auditoria_anti_forjamento_catalogo.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;

-- 1. Catálogo de referência seedado
select is(
    (select count(*) from public.catalogo_eventos_auditoria where nome = 'security.cross_tenant_attempt'),
    1::bigint,
    'Catálogo de eventos contém security.cross_tenant_attempt'
);

-- Setup: Org A (owner 1), Org B (owner 2)
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Audit19 A', 'org-audit19-a') as org_id;

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role = 'authenticated';
create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Audit19 B', 'org-audit19-b') as org_id;

-- Temp tables são propriedade do papel que as criou (authenticated); os passos abaixo
-- leem seu org_id sob outro papel (service_role/anon), então o superusuário de teste
-- precisa conceder select explicitamente antes da troca de papel.
reset role;
grant select on temp_org_a to service_role, anon, authenticated;
grant select on temp_org_b to service_role, anon, authenticated;

-- 2. A migration 37 (ticket 05) já restringe esta RPC a service_role. Um chamador
--    `authenticated` (ex.: um navegador tentando chamar a RPC diretamente) nem chega a
--    executar o corpo da função — é recusado por falta de EXECUTE.
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select throws_ok(
    $$ select public.registrar_evento_auditoria(
        (select org_id from temp_org_a),
        '96000000-0000-4000-8000-000000000001'::uuid,
        'auth.login_success', 'session', null, null, null, null, '{}'::jsonb
    ) $$,
    null,
    null,
    'Chamador authenticated não consegue chamar a RPC de auditoria diretamente (sem EXECUTE)'
);

-- 3. service_role registra evento legítimo (ator é membro real da Org A)
reset role;
set local role service_role;
set local request.jwt.claim.role = 'service_role';

create temp table temp_evt_legit as
select public.registrar_evento_auditoria(
    (select org_id from temp_org_a),
    '96000000-0000-4000-8000-000000000001'::uuid,
    'auth.login_success',
    'session',
    null, null, null, null,
    '{}'::jsonb
) as event_id;

select is(
    (select actor_id from public.eventos_auditoria_sistema where id = (select event_id from temp_evt_legit)),
    '96000000-0000-4000-8000-000000000001'::uuid,
    'service_role registra evento com ator real da organização'
);

-- 4. service_role tenta forjar um par ator/organização que nunca existiu (owner da Org B
--    atribuído a um evento da Org A): a RPC recusa mesmo vindo de service_role — última
--    linha de defesa contra um bug futuro na camada de aplicação.
select throws_ok(
    $$ select public.registrar_evento_auditoria(
        (select org_id from temp_org_a),
        '96000000-0000-4000-8000-000000000002'::uuid,
        'security.cross_tenant_attempt',
        'org',
        null, null, null, null,
        '{}'::jsonb
    ) $$,
    null,
    null,
    'service_role não consegue atribuir um ator que nunca pertenceu à organização (anti-forjamento)'
);

-- 5. Nenhum evento forjado foi de fato persistido a partir da tentativa acima
select is(
    (
        select count(*) from public.eventos_auditoria_sistema
        where organizacao_id = (select org_id from temp_org_a)
          and actor_id = '96000000-0000-4000-8000-000000000002'::uuid
    ),
    0::bigint,
    'Nenhum evento com ator forjado foi persistido'
);

-- 6. service_role pode registrar evento de sistema sem ator humano (null) para org existente
create temp table temp_evt_system as
select public.registrar_evento_auditoria(
    (select org_id from temp_org_a),
    null,
    'webhook.signature_invalid',
    'bling_webhook',
    null, 'corr-sys-1', null, null,
    '{}'::jsonb
) as event_id;

select is(
    (select actor_id from public.eventos_auditoria_sistema where id = (select event_id from temp_evt_system)),
    null::uuid,
    'service_role pode gravar evento de sistema com actor_id null'
);

-- 7. service_role tentando gravar em organização inexistente é recusado
select throws_ok(
    $$ select public.registrar_evento_auditoria(
        '00000000-0000-4000-8000-000000000999'::uuid, null,
        'webhook.signature_invalid', 'bling_webhook', null, null, null, null, '{}'::jsonb
    ) $$,
    null,
    null,
    'service_role não consegue gravar evento para organização inexistente'
);

-- 8. RLS de leitura permanece isolada por organização (owner A não vê evento de outra org)
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select is(
    (select count(*) from public.eventos_auditoria_sistema where organizacao_id = (select org_id from temp_org_a)),
    2::bigint,
    'Owner A visualiza apenas os 2 eventos legítimos da própria organização'
);

select * from finish();
rollback;
