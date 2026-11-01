-- inbox_dedup_chatwoot.test.sql
-- MSG-005, contra o schema canônico completo: a entrega do webhook do Chatwoot
-- é aceita na inbox com dedup por entrega (delivery id) e por evento (chave com
-- revisão), sem engolir revisão legítima, sem cruzar instalações e sem gravar
-- nada quando a entrega é recusada.
--
-- Cenário: A1 e A2 são duas instalações da organização A; B1 é a de B; X1 é
-- uma conexão Bling de A. As chaves seguem o formato do app (`v2:`).
--
-- REINTRODUZIR O DEFEITO (contraprovas executadas aqui, em savepoints):
--   chave só pelo id remoto (formato legado)  → 31: a segunda edição vira duplicata
--   sem o único de eventos                    → 32: a função não tem árbitro e falha
--   entrega sem conferir o evento da entrega  → 33: o delivery id reaproveitado grava outro evento

begin;

select plan(34);

insert into auth.users (id, email) values
    ('e5000000-0000-4000-8000-0000000000a1', 'dono-a-m5@orbita.test'),
    ('e5000000-0000-4000-8000-0000000000b1', 'dono-b-m5@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('e5000000-0000-4000-8000-00000000000a', 'Org A M5', 'org-a-m5', 'active'),
    ('e5000000-0000-4000-8000-00000000000b', 'Org B M5', 'org-b-m5', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000a1', 'owner'),
    ('e5000000-0000-4000-8000-00000000000b', 'e5000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('e5000000-0000-4000-8000-0000000000c1', 'e5000000-0000-4000-8000-00000000000a', 'chatwoot', 'A1', 'conectado'),
    ('e5000000-0000-4000-8000-0000000000c2', 'e5000000-0000-4000-8000-00000000000a', 'chatwoot', 'A2', 'conectado'),
    ('e5000000-0000-4000-8000-0000000000c3', 'e5000000-0000-4000-8000-00000000000b', 'chatwoot', 'B1', 'conectado'),
    ('e5000000-0000-4000-8000-0000000000c4', 'e5000000-0000-4000-8000-00000000000a', 'bling', 'X1', 'conectado');

-- aceitar(conexão, delivery, chave) na organização da conexão.
create function pg_temp.aceitar(p_conexao uuid, p_delivery text, p_chave text, p_tipo text default 'message_created')
returns table (evento_id uuid, status text, is_duplicate boolean, duplicata text)
language sql as $$
    select r.evento_id, r.status, r.is_duplicate, r.duplicata
      from public.aceitar_entrega_inbox_chatwoot(
               (select organizacao_id from public.conexoes_integracao where id = p_conexao),
               p_conexao, null, 1, p_delivery, p_chave, p_tipo, '{"event":"x"}'::jsonb) r
$$;
create function pg_temp.eventos(p_conexao uuid) returns int language sql as $$
    select count(*)::int from public.inbox_eventos_chatwoot where conexao_id = p_conexao
$$;
create function pg_temp.entregas(p_conexao uuid) returns int language sql as $$
    select count(*)::int from public.inbox_entregas_chatwoot where conexao_id = p_conexao
$$;
grant execute on function pg_temp.aceitar(uuid, text, text, text), pg_temp.eventos(uuid), pg_temp.entregas(uuid) to service_role;

set local role service_role;

-- ----------------------------------------------------------------------------
-- 1-6. Catálogo e privilégios.
-- ----------------------------------------------------------------------------
select has_index('public', 'inbox_entregas_chatwoot', 'uq_inbox_entregas_chatwoot_conexao_delivery',
                 array['organizacao_id', 'conexao_id', 'delivery_id'], '1. entrega única por organização + conexão + delivery id');
select ok((select relrowsecurity from pg_class where oid = 'public.inbox_entregas_chatwoot'::regclass), '2. entregas com RLS');
select ok(not has_table_privilege('authenticated', 'public.inbox_entregas_chatwoot', 'select'), '3. o navegador não lê entregas');
select ok(not has_function_privilege('authenticated', 'public.aceitar_entrega_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,text,jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.aceitar_entrega_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,text,jsonb)', 'execute'),
          '4. o navegador não aceita entregas');
select ok(has_function_privilege('service_role', 'public.aceitar_entrega_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,text,jsonb)', 'execute'),
          '5. o service_role aceita entregas');
select throws_ok($$insert into public.inbox_entregas_chatwoot (organizacao_id, conexao_id, delivery_id, evento_id, chave_evento)
                   values ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'id com espaço',
                           gen_random_uuid(), 'k')$$,
                 '23514', null, '6. delivery id fora do formato é recusado');

-- ----------------------------------------------------------------------------
-- 7-10. Entrega nova, persistida e devolvida como recebida.
-- ----------------------------------------------------------------------------
select results_eq($$select status, is_duplicate, duplicata from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c1', 'd-1', 'v2:message_created:msg:500')$$,
                  $$values ('received'::text, false, null::text)$$, '7. created novo: received, não duplicado');
select is(pg_temp.eventos('e5000000-0000-4000-8000-0000000000c1'), 1, '8. o evento ficou gravado');
select is(pg_temp.entregas('e5000000-0000-4000-8000-0000000000c1'), 1, '9. a entrega ficou gravada');
select is((select e.id from public.inbox_eventos_chatwoot e where e.conexao_id = 'e5000000-0000-4000-8000-0000000000c1'),
          (select d.evento_id from public.inbox_entregas_chatwoot d where d.delivery_id = 'd-1'),
          '10. a entrega aponta o evento que carregou');

-- ----------------------------------------------------------------------------
-- 11-14. Duplicatas: a mesma entrega e o mesmo evento em outra entrega.
-- ----------------------------------------------------------------------------
select results_eq($$select is_duplicate, duplicata from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c1', 'd-1', 'v2:message_created:msg:500')$$,
                  $$values (true, 'entrega'::text)$$, '11. a mesma entrega é duplicata de entrega');
select results_eq($$select is_duplicate, duplicata from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c1', 'd-2', 'v2:message_created:msg:500')$$,
                  $$values (true, 'evento'::text)$$, '12. o mesmo created em outra entrega é duplicata de evento');
select results_eq($$select is_duplicate, duplicata from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c1', null, 'v2:message_created:msg:500')$$,
                  $$values (true, 'evento'::text)$$, '13. sem delivery id, o dedup é pela chave');
select is(pg_temp.eventos('e5000000-0000-4000-8000-0000000000c1'), 1, '14. três repetições, um evento');

-- ----------------------------------------------------------------------------
-- 15-18. Revisões legítimas, fora de ordem, e status repetido.
-- ----------------------------------------------------------------------------
select results_eq($$select is_duplicate from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c1', 'd-4', 'v2:message_updated:msg:500:r2', 'message_updated')$$,
                  $$values (false)$$, '15. a segunda edição chega antes da primeira e é aceita');
select results_eq($$select is_duplicate from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c1', 'd-3', 'v2:message_updated:msg:500:r1', 'message_updated')$$,
                  $$values (false)$$, '16. a primeira edição, atrasada, também é aceita');
select is((select count(*)::int from (
              select pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c1', 'd-s' || n, 'v2:conversation_status_changed:conv:50:' || n || ':' || s,
                                     'conversation_status_changed')
                from (values (1, 'open'), (2, 'resolved'), (3, 'open'), (4, 'resolved')) as t(n, s)) x), 4,
          '17. open → resolved → open → resolved: quatro aceites');
select is(pg_temp.eventos('e5000000-0000-4000-8000-0000000000c1'), 7, '18. created + 2 edições + 4 status: sete eventos');

-- ----------------------------------------------------------------------------
-- 19-22. Recusas sem persistência parcial.
-- ----------------------------------------------------------------------------
select throws_ok($$select * from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c1', 'd-1', 'v2:message_created:msg:999')$$,
                 '23505', null, '19. o mesmo delivery id com outro evento é recusado');
select is((select count(*)::int from public.inbox_eventos_chatwoot where idempotency_key = 'v2:message_created:msg:999'), 0,
          '20. e o evento novo daquela chamada não ficou gravado');
select throws_ok($$select * from public.aceitar_entrega_inbox_chatwoot('e5000000-0000-4000-8000-00000000000b',
                     'e5000000-0000-4000-8000-0000000000c1', null, 1, 'd-x', 'v2:message_created:msg:1', 'message_created', '{}'::jsonb)$$,
                 '42501', null, '21. conexão de outra organização é recusada');
select throws_ok($$select * from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c4', 'd-x', 'v2:message_created:msg:1')$$,
                 '42501', null, '22. conexão de outro provedor é recusada');

update public.conexoes_integracao set status = 'desconectado' where id = 'e5000000-0000-4000-8000-0000000000c2';
select throws_ok($$select * from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c2', 'd-1', 'v2:message_created:msg:500')$$,
                 '55000', null, '23. conexão desligada é recusada');
select is(pg_temp.eventos('e5000000-0000-4000-8000-0000000000c2') + pg_temp.entregas('e5000000-0000-4000-8000-0000000000c2'), 0,
          '24. e nada ficou gravado nela');
update public.conexoes_integracao set status = 'conectado' where id = 'e5000000-0000-4000-8000-0000000000c2';

select throws_ok($$select * from public.aceitar_entrega_inbox_chatwoot('e5000000-0000-4000-8000-00000000000a',
                     'e5000000-0000-4000-8000-0000000000c1', null, 1, 'd-big', 'v2:message_created:msg:2', 'message_created',
                     jsonb_build_object('content', repeat('x', 300000)))$$,
                 '22023', null, '25. payload acima do limite é recusado');

-- ----------------------------------------------------------------------------
-- 26-30. Duas instalações e duas organizações com os mesmos ids e delivery ids.
-- ----------------------------------------------------------------------------
select results_eq($$select is_duplicate from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c2', 'd-1', 'v2:message_created:msg:500')$$,
                  $$values (false)$$, '26. A2: mesma mensagem 500 e mesmo delivery id de A1, evento novo');
select results_eq($$select is_duplicate from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c3', 'd-1', 'v2:message_created:msg:500')$$,
                  $$values (false)$$, '27. B1: idem, evento novo');
select is(pg_temp.eventos('e5000000-0000-4000-8000-0000000000c2'), 1, '28. A2 tem só o seu evento');
select is(pg_temp.eventos('e5000000-0000-4000-8000-0000000000c3'), 1, '29. B1 tem só o seu evento');
select is((select count(distinct evento_id)::int from public.inbox_entregas_chatwoot where delivery_id = 'd-1'), 3,
          '30. o delivery id d-1 aponta três eventos, um por instalação');

-- ----------------------------------------------------------------------------
-- 31-33. Contraprovas.
-- ----------------------------------------------------------------------------
savepoint contraprova_chave_legada;
select pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c3', null, 'event_message_updated_msg_500_conv_50', 'message_updated');
select results_eq($$select is_duplicate from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c3', null, 'event_message_updated_msg_500_conv_50', 'message_updated')$$,
                  $$values (true)$$, '31. CONTRAPROVA: com a chave só pelo id, a segunda edição legítima vira duplicata');
rollback to savepoint contraprova_chave_legada;

savepoint contraprova_sem_unico;
reset role;
drop index public.uq_inbox_eventos_chatwoot_conexao_key;
set local role service_role;
select throws_ok($$select * from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c3', null, 'v2:message_created:msg:7')$$,
                 '42P10', null, '32. CONTRAPROVA: sem o único de eventos, não há árbitro e nada é aceito');
rollback to savepoint contraprova_sem_unico;

savepoint contraprova_entrega_sem_conferir;
reset role;
create or replace function public.aceitar_entrega_inbox_chatwoot(
    p_organizacao_id uuid, p_conexao_id uuid, p_user_id uuid, p_inbox_id bigint, p_delivery_id text,
    p_idempotency_key text, p_event_type text, p_payload jsonb)
returns table (evento_id uuid, status text, is_duplicate boolean, duplicata text, cached_response jsonb)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
    insert into public.inbox_eventos_chatwoot as e (organizacao_id, conexao_id, idempotency_key, event_type, payload)
    values (p_organizacao_id, p_conexao_id, p_idempotency_key, p_event_type, p_payload)
    on conflict (organizacao_id, conexao_id, idempotency_key) do nothing returning e.id into v_id;
    insert into public.inbox_entregas_chatwoot (organizacao_id, conexao_id, delivery_id, evento_id, chave_evento)
    select p_organizacao_id, p_conexao_id, p_delivery_id, v_id, p_idempotency_key where v_id is not null
    on conflict (organizacao_id, conexao_id, delivery_id) do nothing;
    return query select v_id, 'received'::text, v_id is null, null::text, null::jsonb;
end;
$$;
set local role service_role;
select pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c3', 'd-1', 'v2:message_created:msg:8');
select is((select count(*)::int from public.inbox_eventos_chatwoot where idempotency_key = 'v2:message_created:msg:8'), 1,
          '33. CONTRAPROVA: sem conferir a entrega, o delivery id reaproveitado grava outro evento');
rollback to savepoint contraprova_entrega_sem_conferir;
select throws_ok($$select * from pg_temp.aceitar('e5000000-0000-4000-8000-0000000000c3', 'd-1', 'v2:message_created:msg:8')$$,
                 '23505', null, '34. sem a sabotagem, o mesmo delivery id com outro evento volta a ser recusado');

select * from finish();
rollback;
