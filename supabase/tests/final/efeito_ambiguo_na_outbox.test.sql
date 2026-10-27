-- efeito_ambiguo_na_outbox.test.sql
-- MSG-007, contra o schema canônico completo (migration 86).
--
-- Um efeito externo despachado tem quatro desfechos: não enviado (com prova),
-- recusado, confirmado (com recibo) e desconhecido. O desconhecido não volta
-- para a fila sozinho: sai por reconciliação com recibo ou por replay
-- autorizado depois de provada a não aplicação. A conclusão é um
-- compare-and-set de dono, fencing token e lease; o token sobe a cada
-- reivindicação, imposto por gatilho.
--
-- REINTRODUZIR O DEFEITO (contraprovas medidas no laboratório, ver runbook):
--   - conclusão e início do despacho sem comparar o fencing token → 16-18 falham
--   - sem `ck_outbox_eventos_sent_confirmado` e com `sent` aceito de qualquer
--     estado no gatilho                                             → 10-11 falham
--   - reaper devolvendo `in_flight` vencido à fila                  → 20-22 falham

begin;

select plan(63);

insert into auth.users (id, email) values
    ('e7000000-0000-4000-8000-0000000000a1', 'dono-a-m7@orbita.test'),
    ('e7000000-0000-4000-8000-0000000000a2', 'membro-a-m7@orbita.test'),
    ('e7000000-0000-4000-8000-0000000000b1', 'dono-b-m7@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('e7000000-0000-4000-8000-00000000000a', 'Org A M7', 'org-a-m7', 'active'),
    ('e7000000-0000-4000-8000-00000000000b', 'Org B M7', 'org-b-m7', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('e7000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-0000000000a1', 'owner'),
    ('e7000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-0000000000a2', 'member'),
    ('e7000000-0000-4000-8000-00000000000b', 'e7000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('e7000000-0000-4000-8000-0000000000c1', 'e7000000-0000-4000-8000-00000000000a', 'chatwoot', 'Principal', 'conectado');

-- Uma intenção registrada pelo caminho real, devolvendo o id.
create function pg_temp.registrar(p_org uuid, p_chave text, p_payload jsonb default '{"conteudo": "x"}')
returns uuid language sql as $$
    select evento_id from public.registrar_evento_outbox(
        p_org, null, null, p_chave, 'chatwoot', 'message.send', p_payload, 3)
$$;

-- Reivindica e despacha um evento; devolve o token.
create function pg_temp.despachar(p_org uuid, p_evento uuid, p_worker text)
returns bigint language plpgsql as $$
declare
    v_token bigint;
begin
    select fencing_token into v_token from public.reivindicar_evento_outbox(p_org, p_evento, p_worker, 60);
    if v_token is null or not public.iniciar_despacho_outbox(p_evento, p_worker, v_token) then
        raise exception 'despacho de teste falhou';
    end if;
    return v_token;
end;
$$;

create function pg_temp.status(p_evento uuid) returns text language sql as $$
    select status from public.outbox_eventos where id = p_evento
$$;

create temp table ev (nome text primary key, id uuid, token bigint);
insert into ev (nome, id) values
    ('ack',      pg_temp.registrar('e7000000-0000-4000-8000-00000000000a', 'm7-ack')),
    ('ok',       pg_temp.registrar('e7000000-0000-4000-8000-00000000000a', 'm7-ok')),
    ('fence',    pg_temp.registrar('e7000000-0000-4000-8000-00000000000a', 'm7-fence')),
    ('voo',      pg_temp.registrar('e7000000-0000-4000-8000-00000000000a', 'm7-voo')),
    ('nao',      pg_temp.registrar('e7000000-0000-4000-8000-00000000000a', 'm7-nao')),
    ('recusa',   pg_temp.registrar('e7000000-0000-4000-8000-00000000000a', 'm7-recusa')),
    ('rec',      pg_temp.registrar('e7000000-0000-4000-8000-00000000000a', 'm7-rec')),
    ('atomico',  pg_temp.registrar('e7000000-0000-4000-8000-00000000000a', 'm7-atomico')),
    ('outra',    pg_temp.registrar('e7000000-0000-4000-8000-00000000000b', 'm7-outra'));
-- Só o caminho de um evento por vez neste teste: nada mais está devido.
update public.outbox_eventos set next_retry_at = now() + interval '1 day'
 where organizacao_id in ('e7000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-00000000000b');
update public.outbox_eventos set next_retry_at = now() where id in (select id from ev);
update public.outbox_eventos set next_retry_at = now() + interval '1 day' where id = (select id from ev where nome = 'outra');

-- ----------------------------------------------------------------------------
-- 1-6. ACK perdido: UNKNOWN, sem segundo despacho, sem saída sem prova.
-- ----------------------------------------------------------------------------
update ev set token = pg_temp.despachar('e7000000-0000-4000-8000-00000000000a', id, 'w1') where nome = 'ack';
select is(public.concluir_tentativa_outbox((select id from ev where nome = 'ack'), 'w1',
          (select token from ev where nome = 'ack'), 'desconhecido', null, null, 'ack_perdido', 'socket fechado', 'transient', 10),
          'unknown', '1. ACK perdido grava unknown');
select is((select count(*)::int from public.reivindicar_tentativas_outbox('w2', 100, 60) r
            where r.evento_id = (select id from ev where nome = 'ack')),
          0, '2. o worker em lote não reivindica unknown (sem segundo despacho)');
select is((select count(*)::int from public.reivindicar_evento_outbox('e7000000-0000-4000-8000-00000000000a',
            (select id from ev where nome = 'ack'), 'w3', 60)),
          0, '3. o envio inline também não reivindica unknown');
select is((select desfecho || '/' || motivo from public.outbox_tentativas where evento_id = (select id from ev where nome = 'ack')),
          'desconhecido/ack_perdido', '4. a tentativa registra o desfecho e o motivo');
select throws_ok($$ update public.outbox_eventos set status = 'pending', motivo_bloqueio = null, desconhecido_em = null
                     where id = (select id from ev where nome = 'ack') $$,
                 '23514', null, '5. unknown → pending sem resolução é recusado, até para o service_role');
select throws_ok($$ update public.outbox_eventos set status = 'failed_transient', motivo_bloqueio = null, desconhecido_em = null
                     where id = (select id from ev where nome = 'ack') $$,
                 '23514', null, '6. unknown → failed_transient é recusado');

-- Os eventos que o batch acabou de reivindicar no passo 2 voltam ao estado
-- anterior: só `ack` interessa aqui. Os demais foram para processing com o
-- worker w2; o reaper os devolve quando a lease vence.
update public.outbox_eventos set lease_expires_at = now() - interval '1 second'
 where status = 'processing' and lease_owner = 'w2';
select is((select count(*)::int from public.liberar_leases_expirados_outbox() r where r.novo_status = 'failed_transient'),
          (select count(*)::int from ev where nome <> 'ack' and nome <> 'outra'),
          '7. reaper: processing vencido nunca despachou e volta à fila');
update public.outbox_eventos set next_retry_at = now() where id in (select id from ev where nome <> 'outra');

-- ----------------------------------------------------------------------------
-- 8-12. Confirmado só com recibo; sent não regride nem nasce fora de in_flight.
-- ----------------------------------------------------------------------------
update ev set token = pg_temp.despachar('e7000000-0000-4000-8000-00000000000a', id, 'w1') where nome = 'ok';
select throws_ok(format($$ select public.concluir_tentativa_outbox(%L, 'w1', %s, 'confirmado', null) $$,
                        (select id from ev where nome = 'ok'), (select token from ev where nome = 'ok')),
                 '22023', null, '8. confirmado sem recibo é recusado');
select is(public.concluir_tentativa_outbox((select id from ev where nome = 'ok'), 'w1', (select token from ev where nome = 'ok'),
          'confirmado', '991', '{"id": 991}'::jsonb),
          'sent', '9. confirmado com recibo grava sent');
select throws_ok($$ update public.outbox_eventos set status = 'sent', confirmacao = 'recibo_provider', recibo_ref = 'x'
                     where id = (select id from ev where nome = 'nao') $$,
                 '23514', null, '10. sent fora de in_flight é recusado (mesmo com recibo)');
select throws_ok($$ update public.outbox_eventos set status = 'sent' where id = (select id from ev where nome = 'nao') $$,
                 '23514', null, '11. sent sem confirmação é recusado');
select throws_ok($$ update public.outbox_eventos set status = 'pending' where id = (select id from ev where nome = 'ok') $$,
                 '23514', null, '12. sent não regride');
select is((select confirmacao || '/' || recibo_ref || '/' || attempts from public.outbox_eventos where id = (select id from ev where nome = 'ok')),
          'recibo_provider/991/2', '13. recibo, origem da confirmação e tentativa contabilizados');
select is((select desfecho || '/' || recibo_ref from public.outbox_tentativas where evento_id = (select id from ev where nome = 'ok')),
          'confirmado/991', '14. a tentativa confirmada guarda o recibo');

-- ----------------------------------------------------------------------------
-- 15-18. Fencing: o mesmo worker id, depois de perder a lease, é outro dono.
-- ----------------------------------------------------------------------------
update ev set token = (select fencing_token from public.reivindicar_evento_outbox(
    'e7000000-0000-4000-8000-00000000000a', id, 'w1', 60)) where nome = 'fence';
update public.outbox_eventos set lease_expires_at = now() - interval '1 second' where id = (select id from ev where nome = 'fence');
select is((select novo_status from public.liberar_leases_expirados_outbox() r where r.evento_id = (select id from ev where nome = 'fence')),
          'failed_transient', '15a. lease de claim sem despacho vencida volta à fila');
update public.outbox_eventos set next_retry_at = now() where id = (select id from ev where nome = 'fence');
create temp table fence_novo as
select * from public.reivindicar_evento_outbox('e7000000-0000-4000-8000-00000000000a', (select id from ev where nome = 'fence'), 'w1', 60);
select is((select fencing_token from fence_novo), (select token + 1 from ev where nome = 'fence'),
          '15. a nova reivindicação sobe o fencing token');
select is(public.iniciar_despacho_outbox((select id from ev where nome = 'fence'), 'w1', (select token from ev where nome = 'fence')),
          false, '16. o token antigo do mesmo worker não despacha');
select is(public.concluir_tentativa_outbox((select id from ev where nome = 'fence'), 'w1', (select token from ev where nome = 'fence'),
          'nao_enviado', null, null, null, 'x', 'transient', 10),
          null, '17. o token antigo do mesmo worker não conclui');
select is(public.iniciar_despacho_outbox((select id from ev where nome = 'fence'), 'w1', (select fencing_token from fence_novo)),
          true, '18. o token vigente despacha');

-- ----------------------------------------------------------------------------
-- 19-23. Lease vencida em voo exige reconciliação.
-- ----------------------------------------------------------------------------
update ev set token = pg_temp.despachar('e7000000-0000-4000-8000-00000000000a', id, 'w1') where nome = 'voo';
update public.outbox_eventos set lease_expires_at = now() - interval '1 second' where id = (select id from ev where nome = 'voo');
select is(public.concluir_tentativa_outbox((select id from ev where nome = 'voo'), 'w1', (select token from ev where nome = 'voo'),
          'confirmado', '777'),
          null, '19. lease vencida em voo: nem o recibo tardio conclui pelo CAS');
select is((select novo_status from public.liberar_leases_expirados_outbox() r where r.evento_id = (select id from ev where nome = 'voo')),
          'unknown', '20. o reaper leva in_flight vencido para unknown');
select is((select motivo_bloqueio from public.outbox_eventos where id = (select id from ev where nome = 'voo')),
          'lease_expirada_em_voo', '21. com o motivo que o operador vê');
select is((select desfecho from public.outbox_tentativas where evento_id = (select id from ev where nome = 'voo')),
          'desconhecido', '22. a tentativa em voo vira desconhecida');
select is(public.concluir_tentativa_outbox((select id from ev where nome = 'voo'), 'w1', (select token from ev where nome = 'voo'),
          'nao_enviado', null, null, null, 'x', 'transient', 10),
          null, '23. o worker antigo não sobrescreve depois do reaper');

-- ----------------------------------------------------------------------------
-- 24-28. Não enviado, recusado e entradas inválidas.
-- ----------------------------------------------------------------------------
update ev set token = pg_temp.despachar('e7000000-0000-4000-8000-00000000000a', id, 'w1') where nome = 'nao';
select is(public.concluir_tentativa_outbox((select id from ev where nome = 'nao'), 'w1', (select token from ev where nome = 'nao'),
          'nao_enviado', null, null, 'transporte_nao_iniciado', 'recusado na conexão', 'transient', 30),
          'failed_transient', '24. não enviado com prova volta à fila com backoff');
select ok((select next_retry_at > now() + interval '20 seconds' from public.outbox_eventos where id = (select id from ev where nome = 'nao')),
          '25. o backoff pedido é honrado');
update ev set token = pg_temp.despachar('e7000000-0000-4000-8000-00000000000a', id, 'w1') where nome = 'recusa';
select is(public.concluir_tentativa_outbox((select id from ev where nome = 'recusa'), 'w1', (select token from ev where nome = 'recusa'),
          'recusado', null, null, 'http_422', 'payload recusado', 'permanent', 10),
          'dead_letter', '26. recusa definitiva vai para dead_letter');
select throws_ok($$ update public.outbox_eventos set status = 'pending' where id = (select id from ev where nome = 'recusa') $$,
                 '23514', null, '27. dead_letter não regride');
select throws_ok(format($$ select public.concluir_tentativa_outbox(%L, 'w9', 1, 'talvez') $$, (select id from ev where nome = 'nao')),
                 '22023', null, '28. desfecho fora do contrato é recusado');

-- Evento reivindicado e não despachado não pode ficar desconhecido.
create temp table claim_rec as
select * from public.reivindicar_evento_outbox('e7000000-0000-4000-8000-00000000000a', (select id from ev where nome = 'rec'), 'w1', 60);
select throws_ok(format($$ select public.concluir_tentativa_outbox(%L, 'w1', %s, 'desconhecido', null, null, 'timeout') $$,
                        (select id from ev where nome = 'rec'), (select fencing_token from claim_rec)),
                 '22023', null, '29. sem despacho iniciado não há desconhecido');

-- ----------------------------------------------------------------------------
-- 30-33. Intenção estável: chave + payload; token monotônico.
-- ----------------------------------------------------------------------------
select is((select evento_id from public.registrar_evento_outbox('e7000000-0000-4000-8000-00000000000a', null, null, 'm7-ok',
           'chatwoot', 'message.send', '{"conteudo": "x"}', 3)),
          (select id from ev where nome = 'ok'), '30. mesma chave e mesma intenção devolvem o evento existente');
select throws_ok($$ select * from public.registrar_evento_outbox('e7000000-0000-4000-8000-00000000000a', null, null, 'm7-ok',
                     'chatwoot', 'message.send', '{"conteudo": "outro"}', 3) $$,
                 '23505', null, '31. mesma chave com outro payload é 23505, não o evento antigo');
select throws_ok($$ update public.outbox_eventos set payload = '{"conteudo": "trocado"}' where id = (select id from ev where nome = 'nao') $$,
                 '23514', null, '32. o payload de uma intenção não muda');
select throws_ok($$ update public.outbox_eventos set fencing_token = 0 where id = (select id from ev where nome = 'nao') $$,
                 '23514', null, '33. o fencing token não regride');

-- ----------------------------------------------------------------------------
-- 34-45. Replay elegível × bloqueado; reconciliação; cross-tenant; papel.
-- ----------------------------------------------------------------------------
select throws_ok($$ select public.autorizar_replay_outbox('e7000000-0000-4000-8000-00000000000a',
                     (select id from ev where nome = 'ack'), 'e7000000-0000-4000-8000-0000000000a1') $$,
                 '55000', null, '34. replay de unknown sem prova de não aplicação é recusado');
select throws_ok($$ select public.autorizar_replay_outbox('e7000000-0000-4000-8000-00000000000a',
                     (select id from ev where nome = 'ack'), 'e7000000-0000-4000-8000-0000000000a2') $$,
                 '42501', null, '35. membro sem papel de gestão não autoriza replay');
select throws_ok($$ select public.autorizar_replay_outbox('e7000000-0000-4000-8000-00000000000b',
                     (select id from ev where nome = 'ack'), 'e7000000-0000-4000-8000-0000000000b1') $$,
                 'P0002', null, '36. a organização B não alcança o evento de A');
select throws_ok($$ select public.resolver_evento_desconhecido_outbox('e7000000-0000-4000-8000-00000000000a',
                     (select id from ev where nome = 'ack'), 'e7000000-0000-4000-8000-0000000000b1', 'revisao_manual') $$,
                 '42501', null, '37. o dono de B não reconcilia em A');
select throws_ok($$ select public.resolver_evento_desconhecido_outbox('e7000000-0000-4000-8000-00000000000a',
                     (select id from ev where nome = 'ack'), 'e7000000-0000-4000-8000-0000000000a1', 'provado_nao_aplicado') $$,
                 '22023', null, '38. provar não aplicação exige evidência');
select is(public.resolver_evento_desconhecido_outbox('e7000000-0000-4000-8000-00000000000a',
          (select id from ev where nome = 'ack'), 'e7000000-0000-4000-8000-0000000000a1', 'provado_nao_aplicado', null,
          'Conferido no Chatwoot: nenhuma mensagem na conversa depois do horário.'),
          'unknown', '39. a prova registrada não libera nada sozinha');
select is(public.autorizar_replay_outbox('e7000000-0000-4000-8000-00000000000a',
          (select id from ev where nome = 'ack'), 'e7000000-0000-4000-8000-0000000000a1'),
          'pending', '40. replay elegível e autorizado volta à fila');
select is((select replay_autorizado_por::text || '/' || attempts from public.outbox_eventos where id = (select id from ev where nome = 'ack')),
          'e7000000-0000-4000-8000-0000000000a1/1', '41. replay guarda quem autorizou e preserva as tentativas');
select is((select fencing_token from public.reivindicar_evento_outbox('e7000000-0000-4000-8000-00000000000a',
           (select id from ev where nome = 'ack'), 'w4', 60)),
          (select token + 1 from ev where nome = 'ack'), '42. o replay é a mesma intenção com novo token');
select throws_ok($$ select public.resolver_evento_desconhecido_outbox('e7000000-0000-4000-8000-00000000000a',
                     (select id from ev where nome = 'voo'), 'e7000000-0000-4000-8000-0000000000a1', 'confirmado') $$,
                 '22023', null, '43. confirmar exige a referência exata do provedor');
select is(public.resolver_evento_desconhecido_outbox('e7000000-0000-4000-8000-00000000000a',
          (select id from ev where nome = 'voo'), 'e7000000-0000-4000-8000-0000000000a1', 'confirmado', '777'),
          'sent', '44. reconciliação com recibo confirma');
select throws_ok($$ select public.resolver_evento_desconhecido_outbox('e7000000-0000-4000-8000-00000000000a',
                     (select id from ev where nome = 'voo'), 'e7000000-0000-4000-8000-0000000000a1', 'revisao_manual') $$,
                 '55000', null, '45. só unknown é reconciliável');

-- ----------------------------------------------------------------------------
-- 46-49. Atomicidade: uma falha no meio desfaz a chamada inteira.
-- ----------------------------------------------------------------------------
create temp table claim_atomico as
select * from public.reivindicar_evento_outbox('e7000000-0000-4000-8000-00000000000a', (select id from ev where nome = 'atomico'), 'w1', 60);
insert into public.outbox_tentativas (organizacao_id, evento_id, fencing_token, worker_id)
values ('e7000000-0000-4000-8000-00000000000a', (select id from ev where nome = 'atomico'), (select fencing_token from claim_atomico), 'intruso');
select throws_ok(format($$ select public.iniciar_despacho_outbox(%L, 'w1', %s) $$,
                        (select id from ev where nome = 'atomico'), (select fencing_token from claim_atomico)),
                 '23505', null, '46. falha ao registrar a tentativa aborta o início do despacho');
select is(pg_temp.status((select id from ev where nome = 'atomico')), 'processing',
          '47. e o evento não ficou em voo pela metade');
select throws_ok(format($$ select public.concluir_tentativa_outbox(%L, 'w1', %s, 'nao_enviado', null, null, null, 'x', 'inventada') $$,
                        (select id from ev where nome = 'atomico'), (select fencing_token from claim_atomico)),
                 '22023', null, '48. categoria fora do contrato é recusada');
select is(pg_temp.status((select id from ev where nome = 'atomico')), 'processing', '49. sem efeito parcial');

-- ----------------------------------------------------------------------------
-- 50-55. Tentativas: imutáveis, sem atravessar organização.
-- ----------------------------------------------------------------------------
select throws_ok($$ update public.outbox_tentativas set desfecho = 'em_voo', concluida_em = null
                     where evento_id = (select id from ev where nome = 'ok') $$,
                 '23514', null, '50. desfecho de tentativa não volta para em_voo');
select throws_ok($$ update public.outbox_tentativas set fencing_token = 99 where evento_id = (select id from ev where nome = 'ok') $$,
                 '23514', null, '51. identidade da tentativa é imutável');
select throws_ok($$ insert into public.outbox_tentativas (organizacao_id, evento_id, fencing_token, worker_id)
                     values ('e7000000-0000-4000-8000-00000000000b', (select id from ev where nome = 'ok'), 50, 'x') $$,
                 '23503', null, '52. tentativa de B não aponta para evento de A');
select throws_ok($$ update public.outbox_eventos set organizacao_id = 'e7000000-0000-4000-8000-00000000000b'
                     where id = (select id from ev where nome = 'nao') $$,
                 '23514', null, '53. a organização de uma intenção não muda');
select throws_ok($$ update public.outbox_eventos set status = 'in_flight' where id = (select id from ev where nome = 'nao') $$,
                 '23514', null, '54. em voo só a partir de uma reivindicação');
select throws_ok($$ update public.outbox_eventos set status = 'unknown', motivo_bloqueio = 'invente', desconhecido_em = now()
                     where id = (select id from ev where nome = 'rec') $$,
                 '23514', null, '55. motivo fora da lista é recusado');

-- ----------------------------------------------------------------------------
-- 56-62. Privilégios e RLS.
-- ----------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('reivindicar_tentativas_outbox', 'reivindicar_evento_outbox', 'iniciar_despacho_outbox',
                                'concluir_tentativa_outbox', 'liberar_leases_expirados_outbox',
                                'resolver_evento_desconhecido_outbox', 'autorizar_replay_outbox', 'registrar_evento_outbox')
              and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
          0, '56. o navegador não executa nenhuma RPC da outbox');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('reivindicar_tentativas_outbox', 'reivindicar_evento_outbox', 'iniciar_despacho_outbox',
                                'concluir_tentativa_outbox', 'liberar_leases_expirados_outbox',
                                'resolver_evento_desconhecido_outbox', 'autorizar_replay_outbox', 'registrar_evento_outbox')
              and has_function_privilege('service_role', p.oid, 'execute')),
          8, '57. o servidor executa as oito');
select ok(to_regprocedure('public.concluir_evento_outbox(uuid,text,text,jsonb,text,text,integer)') is null
          and to_regprocedure('public.reivindicar_lote_outbox(text,integer,integer)') is null,
          '58. a conclusão e o claim legados, sem fencing, não existem');
select ok(not has_table_privilege('authenticated', 'public.outbox_tentativas', 'SELECT')
          and not has_table_privilege('authenticated', 'public.outbox_eventos', 'UPDATE')
          and not has_table_privilege('anon', 'public.outbox_eventos', 'SELECT'),
          '59. o navegador não lê tentativas nem escreve eventos');

set local role authenticated;
set local request.jwt.claim.sub = 'e7000000-0000-4000-8000-0000000000a1';
select is((select count(*)::int from public.outbox_eventos where organizacao_id = 'e7000000-0000-4000-8000-00000000000b'),
          0, '60. RLS: o dono de A não vê eventos de B');
select ok((select count(*) from public.outbox_eventos where organizacao_id = 'e7000000-0000-4000-8000-00000000000a') >= 8,
          '61. RLS: o dono de A vê os da própria organização');
select throws_ok($$ select count(*) from public.outbox_tentativas $$, '42501', null,
                 '62. o navegador não lê tentativas');
reset role;

select * from finish();
rollback;
