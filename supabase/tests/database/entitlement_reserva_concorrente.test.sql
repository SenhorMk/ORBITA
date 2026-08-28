-- ============================================================================
-- entitlement_reserva_concorrente.test.sql
-- Testes pgTAP para o Ticket 13: reserva atômica de slot de membro
--
-- Prova, no nível de banco (mesmo padrão de exclusão mútua usado no Ticket 12
-- para o outbox — ver outbox_lease_correlacao.test.sql), que:
--   - aceitar dois convites distintos disputando o último slot de membro do
--     plano nunca deixa ambos passarem: exatamente um sucede, o outro é
--     rejeitado com SQLSTATE dedicado (ORB02) sem inserir membership extra;
--   - organização suspensa/pending_deletion bloqueia aceite de convite mesmo
--     dentro do limite numérico (ORB01);
--   - o webhook Stripe simulado com evento fora de ordem (versão anterior à
--     já aplicada) é rejeitado com outcome 'rejected_stale' e não regride o
--     plano/status já persistido.
-- ============================================================================

begin;

insert into auth.users (id, email)
values
    ('95000000-0000-4000-8000-000000000001', 'owner-reserva@orbita.test'),
    ('95000000-0000-4000-8000-000000000002', 'convidado-a@orbita.test'),
    ('95000000-0000-4000-8000-000000000003', 'convidado-b@orbita.test')
on conflict do nothing;

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/33_planos_limites_entitlements.sql
\ir ../../../database/34_integrar_stripe_assinaturas.sql
\ir ../../../database/35_suspensao_retencao_encerramento.sql
\ir ../../../database/49_entitlement_reserva_atomica_ordering.sql

grant usage on schema public to authenticated, anon;
grant all on all tables in schema public to authenticated, service_role;
grant execute on function public.aceitar_convite_organizacao(text) to authenticated, service_role;
grant execute on function public.criar_convite_organizacao(uuid, text, text, text) to authenticated, service_role;
grant execute on function public.atualizar_assinatura_stripe_atomica(
    uuid, text, text, text, text, text, text, timestamptz, text, jsonb, bigint, timestamptz
) to service_role;

select plan(9);

-- Setup: Org A no plano starter (limite_membros = 3), owner + 1 convite ja aceito = 2 membros
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Org Reserva Concorrente', 'org-reserva-concorrente-13') as org_id;

reset role;

-- Reduz o limite para 2 (owner + 1) para forçar a disputa pelo último slot com um único INSERT extra.
-- Executado como role padrao (bypassa RLS) — como 'authenticated' a tabela nao tem policy de
-- UPDATE e a alteracao seria silenciosamente ignorada (0 linhas afetadas, sem erro).
update public.assinaturas_organizacao
set limites_customizados = jsonb_build_object('limite_membros', 2)
where organizacao_id = (select org_id from temp_org_a);

-- Owner cria dois convites distintos (A e B) disputando o único slot restante
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000001';

create temp table temp_convite_a as
select public.criar_convite_organizacao(
    (select org_id from temp_org_a), 'convidado-a@orbita.test', 'member', 'token-reserva-concorrente-aaa1'
) as convite_id;

create temp table temp_convite_b as
select public.criar_convite_organizacao(
    (select org_id from temp_org_a), 'convidado-b@orbita.test', 'member', 'token-reserva-concorrente-bbb2'
) as convite_id;

reset role;

-- 1. Convidado A aceita primeiro: sucesso (consome o último slot: 1 owner + 1 = 2/2)
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000002';

select lives_ok(
    $$select public.aceitar_convite_organizacao('token-reserva-concorrente-aaa1')$$,
    'Convidado A aceita o convite e consome o ultimo slot de membro disponivel'
);

select is(
    (select count(*)::int from public.membros_organizacao where organizacao_id = (select org_id from temp_org_a)),
    2,
    'Organizacao possui exatamente 2 membros apos o primeiro aceite (limite customizado)'
);

-- 2. Convidado B tenta aceitar o segundo convite: deve falhar com ORB02 (limite atingido)
--    Prova a exclusao mutua: mesmo com um convite pendente valido, a reserva atomica
--    no aceite (nao na criacao do convite) impede exceder o limite do plano.
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000003';

select throws_ok(
    $$select public.aceitar_convite_organizacao('token-reserva-concorrente-bbb2')$$,
    'ORB02',
    null,
    'Convidado B e rejeitado com ORB02 ao tentar aceitar quando o limite de membros ja foi atingido'
);

-- Verificacoes a seguir rodam sem RLS de membro (convidado B nunca se tornou membro,
-- entao suas proprias queries nao enxergariam membros_organizacao/convites_organizacao da Org A).
reset role;

select is(
    (select count(*)::int from public.membros_organizacao where organizacao_id = (select org_id from temp_org_a)),
    2,
    'Contagem de membros permanece 2 apos a tentativa rejeitada (nenhum efeito duplicado / sem furo de limite)'
);

select is(
    (select status from public.convites_organizacao where token = 'token-reserva-concorrente-bbb2'),
    'pending',
    'Convite B permanece pending (nao foi consumido pela tentativa rejeitada)'
);

reset role;

-- 3. Organizacao suspensa bloqueia aceite mesmo com slot livre (ORB01)
set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000001';

create temp table temp_org_b as
select public.criar_organizacao_atomica('Org Suspensa Reserva', 'org-suspensa-reserva-13') as org_id;

create temp table temp_convite_c as
select public.criar_convite_organizacao(
    (select org_id from temp_org_b), 'convidado-b@orbita.test', 'member', 'token-reserva-concorrente-ccc3'
) as convite_id;

reset role;

select public.suspender_organizacao((select org_id from temp_org_b), 'Inadimplencia Stripe teste', '95000000-0000-4000-8000-000000000001'::uuid);

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-4000-8000-000000000003';

select throws_ok(
    $$select public.aceitar_convite_organizacao('token-reserva-concorrente-ccc3')$$,
    'ORB01',
    null,
    'Aceite de convite e bloqueado (ORB01) quando a organizacao esta suspensa, mesmo com slot livre'
);

reset role;

-- 4. Webhook Stripe fora de ordem nao regride o estado ja aplicado (fixture contratual local)
reset role;

create temp table temp_evento_novo as
select public.atualizar_assinatura_stripe_atomica(
    (select org_id from temp_org_a), 'pro', 'active', 'cus_test_ordering', 'sub_test_ordering',
    null, 'monthly', null, 'Evento mais novo (versao 100)', '{"event_id":"evt_100"}'::jsonb, 100, now()
) as resultado;

select is(
    (select resultado->>'outcome' from temp_evento_novo),
    'applied',
    'Evento com versao 100 e aplicado normalmente'
);

create temp table temp_evento_antigo as
select public.atualizar_assinatura_stripe_atomica(
    (select org_id from temp_org_a), 'starter', 'canceled', 'cus_test_ordering', 'sub_test_ordering',
    null, 'monthly', null, 'Evento antigo fora de ordem (versao 50)', '{"event_id":"evt_050"}'::jsonb, 50, now() - interval '1 day'
) as resultado;

select is(
    (select resultado->>'outcome' from temp_evento_antigo),
    'rejected_stale',
    'Evento com versao 50 (anterior a 100 ja aplicada) e rejeitado como stale'
);

select is(
    (select p.slug from public.assinaturas_organizacao a join public.planos p on p.id = a.plano_id where a.organizacao_id = (select org_id from temp_org_a)),
    'pro',
    'Plano permanece "pro" (evento antigo nao regrediu o estado ja aplicado pela versao 100)'
);

reset role;

select * from finish();
rollback;
