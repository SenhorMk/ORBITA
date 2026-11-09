-- envio_chatwoot_por_consumidor.test.sql
-- MSG-008, contra o schema canônico completo: a intenção de envio nasce com o
-- evento da outbox numa transação, é única por organização + command_id, só o
-- worker a reivindica (nunca o backlog inline), e a confirmação grava a
-- mensagem espelhada com proveniência. Concorrência real está em
-- scripts/database-concurrency-envio-chatwoot.mjs.

begin;

select plan(57);

set local request.jwt.claim.role = 'service_role';

insert into auth.users (id, email) values
    ('e8000000-0000-4000-8000-0000000000a1', 'dono-a-m8@orbita.test'),
    ('e8000000-0000-4000-8000-0000000000b1', 'dono-b-m8@orbita.test'),
    ('e8000000-0000-4000-8000-0000000000f1', 'fora-m8@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('e8000000-0000-4000-8000-00000000000a', 'Org A M8', 'org-a-m8', 'active'),
    ('e8000000-0000-4000-8000-00000000000b', 'Org B M8', 'org-b-m8', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1', 'member'),
    ('e8000000-0000-4000-8000-00000000000b', 'e8000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('e8000000-0000-4000-8000-0000000000c1', 'e8000000-0000-4000-8000-00000000000a', 'chatwoot', 'A1', 'conectado'),
    ('e8000000-0000-4000-8000-0000000000c2', 'e8000000-0000-4000-8000-00000000000a', 'chatwoot', 'A2', 'conectado'),
    ('e8000000-0000-4000-8000-0000000000c3', 'e8000000-0000-4000-8000-00000000000a', 'chatwoot', 'A3', 'conectado'),
    ('e8000000-0000-4000-8000-0000000000d1', 'e8000000-0000-4000-8000-00000000000b', 'chatwoot', 'B1', 'conectado');

create temp table t_ctx (nome text primary key, valor text) on commit drop;

-- Uma mensagem pela inbox (MSG-006): cria contato e conversa pelo caminho real.
create function pg_temp.inbox(p_org uuid, p_conexao uuid, p_chave text, p_msg int, p_conv int,
                              p_tipo text, p_remetente text, p_abre boolean)
returns text language plpgsql as $$
declare
    v_evento uuid;
    v_token bigint;
begin
    select evento_id into v_evento from public.aceitar_entrega_inbox_chatwoot(
        p_org, p_conexao, null, 1, null, p_chave, 'message_created', '{"event":"x"}'::jsonb);
    select r.fencing_token into v_token
      from public.reivindicar_eventos_inbox_chatwoot('w-inbox', 50, 60, 'epoch'::timestamptz) r
     where r.evento_id = v_evento;
    return (select a.disposicao from public.aplicar_evento_inbox_chatwoot(v_evento, 'w-inbox', v_token,
        jsonb_build_object(
            'evento', 'message_created', 'acao', 'espelhar', 'account_id', '1', 'abre_caso', p_abre, 'revisao_conteudo_em', null,
            'contato', jsonb_build_object('id', 5, 'nome', 'Contato'),
            'conversa', jsonb_build_object('id', p_conv, 'contato_id', 5, 'status', 'open', 'inbox_id', 1, 'canal', 'Channel::Api'),
            'mensagem', jsonb_build_object('id', p_msg, 'conversa_id', p_conv, 'conteudo', 'texto', 'tipo', p_tipo,
                                           'remetente_tipo', p_remetente, 'modo', 'preservar'))) a);
end;
$$;

create function pg_temp.conversa(p_conexao uuid, p_conv int)
returns uuid language sql as $$
    select id_local from public.chatwoot_conversations where conexao_id = p_conexao and id_externo = p_conv::text;
$$;

create function pg_temp.registrar(p_org uuid, p_ator uuid, p_conversa uuid, p_comando uuid, p_texto text)
returns text language sql as $$
    select resultado from public.registrar_envio_chatwoot(p_org, p_ator, p_conversa, p_comando, p_texto);
$$;

-- Reivindica o envio do evento para o worker; devolve o token.
create function pg_temp.token(p_evento uuid, p_worker text, p_desde timestamptz default 'epoch')
returns bigint language sql as $$
    select r.fencing_token from public.reivindicar_envios_chatwoot(p_worker, 50, 60, p_desde, 2) r where r.evento_id = p_evento;
$$;

create function pg_temp.evento(p_org uuid, p_comando uuid)
returns uuid language sql as $$
    select outbox_evento_id from public.chatwoot_envios where organizacao_id = p_org and command_id = p_comando;
$$;

-- Conversa 50 da cliente nas conexões A1, A2 e B1 (mesmo id remoto) e 60 em A3.
select pg_temp.inbox('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000c1', 'a1-1', 9001, 50, 'incoming', 'contact', true);
select pg_temp.inbox('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000c2', 'a2-1', 9001, 50, 'incoming', 'contact', true);
select pg_temp.inbox('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000c3', 'a3-1', 9001, 60, 'incoming', 'contact', true);
select pg_temp.inbox('e8000000-0000-4000-8000-00000000000b', 'e8000000-0000-4000-8000-0000000000d1', 'b1-1', 9001, 50, 'incoming', 'contact', true);
insert into t_ctx values
    ('a1', pg_temp.conversa('e8000000-0000-4000-8000-0000000000c1', 50)::text),
    ('a2', pg_temp.conversa('e8000000-0000-4000-8000-0000000000c2', 50)::text),
    ('a3', pg_temp.conversa('e8000000-0000-4000-8000-0000000000c3', 60)::text),
    ('b1', pg_temp.conversa('e8000000-0000-4000-8000-0000000000d1', 50)::text);

-- ---------------------------------------------------------------------------
-- Superfície: nenhum cliente registra, reivindica ou conclui.
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.chatwoot_envios'::regclass), '1. chatwoot_envios com RLS');
select ok(not has_table_privilege('authenticated', 'public.chatwoot_envios', 'select'), '2. navegador não lê intenções direto');
select ok(not has_table_privilege('anon', 'public.chatwoot_envios', 'select'), '3. anônimo não lê intenções');
select ok(not has_table_privilege('service_role', 'public.chatwoot_envios', 'insert')
          and not has_table_privilege('service_role', 'public.chatwoot_envios', 'update')
          and not has_table_privilege('service_role', 'public.chatwoot_envios', 'delete'),
          '4. nem o service_role escreve na intenção fora das funções');
select is(
    (select count(*)::int
       from (values ('public.registrar_envio_chatwoot(uuid,uuid,uuid,uuid,text)'),
                    ('public.reivindicar_envios_chatwoot(text,integer,integer,timestamptz,integer)'),
                    ('public.concluir_envio_chatwoot(uuid,text,bigint,text,text,text,text,text,integer,jsonb)'),
                    ('public.auditar_envio_chatwoot(uuid,uuid,text,uuid,jsonb)')) as f(assinatura)
      cross join (values ('authenticated'), ('anon'), ('public')) as r(rolname)
      where has_function_privilege(r.rolname, f.assinatura, 'execute')),
    0, '5. navegador, anônimo e public não executam nenhuma função do envio');
select ok(not has_function_privilege('service_role', 'public.auditar_envio_chatwoot(uuid,uuid,text,uuid,jsonb)', 'execute'),
          '6. a trilha só é escrita de dentro das funções');
select is((select array_agg(a.attname::text order by a.attname)
             from pg_constraint c
             join pg_attribute a on a.attrelid = c.confrelid and a.attnum = any (c.confkey)
            where c.conname = 'fk_chatwoot_envios_conversa'),
          array['id_local', 'organizacao_id'], '6b. a intenção aponta para a conversa pelo UUID local e organização, nunca pelo id remoto');

-- ---------------------------------------------------------------------------
-- Registro: intenção + outbox + auditoria juntos; identidade pelo command_id.
-- ---------------------------------------------------------------------------
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                            (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-000000000001', 'Olá, já vejo'),
          'registrado', '7. primeiro pedido registra');
select is((select count(*)::int from public.outbox_eventos
            where organizacao_id = 'e8000000-0000-4000-8000-00000000000a' and destination = 'chatwoot' and event_type = 'message.send'
              and status = 'pending' and idempotency_key = 'chatwoot.message.send:c8000000-0000-4000-8000-000000000001'),
          1, '8. um evento pendente na outbox, com a chave do comando');
select ok((select not (payload ? 'conteudo') and payload ->> 'payload_digest' ~ '^[0-9a-f]{64}$'
             from public.outbox_eventos where id = pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000001')),
          '9. o payload da outbox leva o digest, não o texto');
select is((select payload_digest from public.chatwoot_envios where command_id = 'c8000000-0000-4000-8000-000000000001'),
          encode(sha256(convert_to((select valor from t_ctx where nome = 'a1') || chr(10) || 'Olá, já vejo', 'UTF8')), 'hex'),
          '10. digest = sha256(conversa + texto)');
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                            (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-000000000001', 'Olá, já vejo'),
          'existente', '11. clique duplo/reload: mesmo comando e mesmo texto devolvem a mesma intenção');
select is((select count(*)::int from public.chatwoot_envios where command_id = 'c8000000-0000-4000-8000-000000000001')
          + (select count(*)::int from public.outbox_eventos where idempotency_key = 'chatwoot.message.send:c8000000-0000-4000-8000-000000000001'),
          2, '12. continua uma intenção e um evento');
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                            (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-000000000001', 'Outro texto'),
          'conflito', '13. mesmo comando com outro texto: conflito');
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                            (select valor::uuid from t_ctx where nome = 'a2'), 'c8000000-0000-4000-8000-000000000001', 'Olá, já vejo'),
          'conflito', '14. mesmo comando em outra conversa: conflito');
select is((select count(*)::int from public.chatwoot_envios where organizacao_id = 'e8000000-0000-4000-8000-00000000000a'),
          1, '15. conflitos não gravam nada');
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000b', 'e8000000-0000-4000-8000-0000000000b1',
                            (select valor::uuid from t_ctx where nome = 'b1'), 'c8000000-0000-4000-8000-000000000001', 'Olá, já vejo'),
          'registrado', '16. o mesmo command_id em B é outra intenção');
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000f1',
                            (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-000000000002', 'x'),
          'sem_vinculo', '17. quem não é membro não registra');
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                            (select valor::uuid from t_ctx where nome = 'b1'), 'c8000000-0000-4000-8000-000000000003', 'x'),
          'conversa_inexistente', '18. conversa de B pedida por A: não existe para A');
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                            'e8000000-0000-4000-8000-0000000000ff', 'c8000000-0000-4000-8000-000000000004', 'x'),
          'conversa_inexistente', '19. UUID adulterado: não existe');
update public.conexoes_integracao set status = 'desconectado' where id = 'e8000000-0000-4000-8000-0000000000c3';
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                            (select valor::uuid from t_ctx where nome = 'a3'), 'c8000000-0000-4000-8000-000000000005', 'x'),
          'conexao_indisponivel', '20. conexão desligada: nada registrado');
select is((select count(*)::int from public.chatwoot_envios where organizacao_id = 'e8000000-0000-4000-8000-00000000000a'),
          1, '21. recusas não gravam intenção');
select throws_ok($$ select public.registrar_envio_chatwoot('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                       (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-000000000006', ' com espaço') $$,
                 '22023', null, '22. texto fora da forma normalizada é recusado');
select throws_ok($$ select public.registrar_envio_chatwoot('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                       (select valor::uuid from t_ctx where nome = 'a1'), null, 'x') $$,
                 '22023', null, '23. sem command_id é recusado');
select ok((select actor_id = 'e8000000-0000-4000-8000-0000000000a1' and not (metadata ? 'conteudo')
             from public.eventos_auditoria_sistema
            where acao = 'chatwoot.send_requested' and organizacao_id = 'e8000000-0000-4000-8000-00000000000a'),
          '24. pedido auditado com o autor e sem o texto');

-- ---------------------------------------------------------------------------
-- Claim: só intenções registradas, só desde o corte.
-- ---------------------------------------------------------------------------
select throws_ok($$ select * from public.reivindicar_envios_chatwoot('w-1', 10, 60, null, 2) $$, '22023', null,
                 '25. claim sem corte do backlog é recusado');
-- Backlog do envio inline: evento sem intenção.
select evento_id from public.registrar_evento_outbox('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000c1',
    'e8000000-0000-4000-8000-0000000000a1', 'chatwoot_msg_legado_1', 'chatwoot', 'message.send', '{"content":"antigo"}'::jsonb, 5);
select is((select count(*)::int from public.reivindicar_envios_chatwoot('w-corte', 50, 60, now() + interval '1 second', 2)),
          0, '26. intenção anterior ao corte não é reivindicada');
insert into t_ctx values ('token1', pg_temp.token(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000001'), 'w-1')::text);
select is((select valor::bigint from t_ctx where nome = 'token1'), 1::bigint, '27. o worker reivindica o envio com token 1');
select is((select status from public.outbox_eventos where idempotency_key = 'chatwoot_msg_legado_1'),
          'pending', '28. o backlog inline (sem intenção) nunca é reivindicado');
select is((select count(*)::int from public.reivindicar_envios_chatwoot('w-2', 50, 60, 'epoch', 2)
            where evento_id = pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000001')),
          0, '29. um segundo worker não pega o envio reivindicado');
-- B entrou no lote junto com A: o evento de B segue a conexão da conversa de B.
select ok((select status = 'processing' and conexao_id = 'e8000000-0000-4000-8000-0000000000d1'
             from public.outbox_eventos where id = pg_temp.evento('e8000000-0000-4000-8000-00000000000b', 'c8000000-0000-4000-8000-000000000001')),
          '30. cada envio sai pela conexão da própria conversa');

-- ---------------------------------------------------------------------------
-- Conclusão: só com recibo, mensagem espelhada com proveniência, uma vez.
-- ---------------------------------------------------------------------------
select ok(public.iniciar_despacho_outbox(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000001'),
                                         'w-1', 1), '31. despacho iniciado antes da rede');
select throws_ok($$ select * from public.concluir_envio_chatwoot(
                       pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000001'),
                       'w-1', 1, 'confirmado', 'abc') $$,
                 '22023', null, '32. recibo que não é id do Chatwoot é recusado');
select is((select c.status from public.concluir_envio_chatwoot(
               pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000001'),
               'w-1', 2, 'confirmado', '9101') c),
          null, '33. token velho/outro não conclui');
select is((select c.status from public.concluir_envio_chatwoot(
               pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000001'),
               'w-1', 1, 'confirmado', '9101', null, null, null, 10,
               '{"remetente_nome":"Agente","remetente_id":7,"remetente_tipo":"user","criada_em":"2026-11-05T12:00:00Z"}'::jsonb) c),
          'sent', '34. recibo confirma');
select ok((select m.envio_id = e.id and m.message_type = 'outgoing' and m.content = 'Olá, já vejo'
                  and m.conexao_id = 'e8000000-0000-4000-8000-0000000000c1' and m.id_externo = '9101'
                  and e.mensagem_id_local = m.id_local
             from public.chatwoot_envios e join public.chatwoot_messages m on m.id_local = e.mensagem_id_local
            where e.command_id = 'c8000000-0000-4000-8000-000000000001' and e.organizacao_id = 'e8000000-0000-4000-8000-00000000000a'),
          '35. a mensagem espelhada nasce na confirmação, ligada à intenção');
select ok(exists (select 1 from public.eventos_auditoria_sistema where acao = 'chatwoot.send_confirmed'
                   and organizacao_id = 'e8000000-0000-4000-8000-00000000000a'), '36. confirmação auditada');
insert into t_ctx values ('casos_antes', (select count(*) from public.sac_cases)::text);
select isnt(pg_temp.inbox('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000c1', 'a1-propria', 9101, 50,
                          'outgoing', 'user', false),
            'caso_aberto', '37. o webhook da própria resposta é consumido sem abrir caso');
select is((select count(*)::int from public.sac_cases), (select valor::int from t_ctx where nome = 'casos_antes'),
          '38. a própria resposta não abre caso (nem dispara trabalho derivado)');
select ok((select count(*) = 1 and bool_and(envio_id is not null) from public.chatwoot_messages
            where conexao_id = 'e8000000-0000-4000-8000-0000000000c1' and id_externo = '9101'),
          '39. continua uma mensagem, com a proveniência preservada');

-- Webhook antes da confirmação: a linha existe e só ganha a proveniência.
select pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                         (select valor::uuid from t_ctx where nome = 'a2'), 'c8000000-0000-4000-8000-000000000007', 'Pela A2');
insert into t_ctx values ('token2', pg_temp.token(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000007'), 'w-3')::text);
select public.iniciar_despacho_outbox(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000007'),
                                      'w-3', (select valor::bigint from t_ctx where nome = 'token2'));
select pg_temp.inbox('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000c2', 'a2-propria', 9102, 50,
                     'outgoing', 'user', false);
select is((select c.status from public.concluir_envio_chatwoot(
               pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000007'),
               'w-3', (select valor::bigint from t_ctx where nome = 'token2'), 'confirmado', '9102') c),
          'sent', '40. confirmação depois do webhook da própria resposta');
select ok((select count(*) = 1 and bool_and(envio_id is not null) from public.chatwoot_messages
            where conexao_id = 'e8000000-0000-4000-8000-0000000000c2' and id_externo = '9102'),
          '41. a linha do webhook ganha a proveniência, sem duplicar');
select is((select count(*)::int from public.chatwoot_messages
            where organizacao_id = 'e8000000-0000-4000-8000-00000000000a' and id_externo = '9102'),
          1, '42. duas conexões da mesma organização não compartilham a mensagem');

-- ---------------------------------------------------------------------------
-- Ambíguos: unknown, sem mensagem, nunca reivindicável.
-- ---------------------------------------------------------------------------
select pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                         (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-000000000008', 'Timeout');
insert into t_ctx values ('token3', pg_temp.token(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000008'), 'w-4')::text);
select public.iniciar_despacho_outbox(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000008'),
                                      'w-4', (select valor::bigint from t_ctx where nome = 'token3'));
select is((select c.status from public.concluir_envio_chatwoot(
               pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000008'),
               'w-4', (select valor::bigint from t_ctx where nome = 'token3'), 'desconhecido', null, 'timeout', 'Sem resposta.', 'transient') c),
          'unknown', '43. timeout vira unknown');
select ok((select mensagem_id_local is null from public.chatwoot_envios where command_id = 'c8000000-0000-4000-8000-000000000008'),
          '44. unknown não cria mensagem');
select ok(exists (select 1 from public.eventos_auditoria_sistema where acao = 'outbox.effect_unknown'
                   and recurso = 'chatwoot_envio' and organizacao_id = 'e8000000-0000-4000-8000-00000000000a'),
          '45. unknown auditado');
select is((select count(*)::int from public.reivindicar_envios_chatwoot('w-5', 50, 60, 'epoch', 2)
            where evento_id = pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000008')),
          0, '46. unknown não volta a ser reivindicado');
select is(pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                            (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-000000000008', 'Timeout'),
          'existente', '47. retry humano com o mesmo command_id devolve a intenção desconhecida, sem criar outra');

-- Queda depois do efeito: a lease vence com o despacho em voo.
select pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                         (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-000000000009', 'Queda');
insert into t_ctx values ('token4', pg_temp.token(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000009'), 'w-6')::text);
select public.iniciar_despacho_outbox(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000009'),
                                      'w-6', (select valor::bigint from t_ctx where nome = 'token4'));
update public.outbox_eventos set lease_expires_at = now() - interval '1 second'
 where id = pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000009');
select is((select c.status from public.concluir_envio_chatwoot(
               pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000009'),
               'w-6', (select valor::bigint from t_ctx where nome = 'token4'), 'confirmado', '9109') c),
          null, '48. recibo depois da lease vencida não confirma');
select ok(not exists (select 1 from public.chatwoot_messages where id_externo = '9109'),
          '49. e não cria mensagem');
select ok(exists (select 1 from public.liberar_leases_expirados_outbox() r
                   where r.evento_id = pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-000000000009')
                     and r.novo_status = 'unknown'),
          '50. o reaper leva o despacho em voo a unknown, não à fila');

-- Recusa definitiva.
select pg_temp.registrar('e8000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-0000000000a1',
                         (select valor::uuid from t_ctx where nome = 'a1'), 'c8000000-0000-4000-8000-00000000000a', 'Recusa');
insert into t_ctx values ('token5', pg_temp.token(pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-00000000000a'), 'w-7')::text);
select is((select c.status from public.concluir_envio_chatwoot(
               pg_temp.evento('e8000000-0000-4000-8000-00000000000a', 'c8000000-0000-4000-8000-00000000000a'),
               'w-7', (select valor::bigint from t_ctx where nome = 'token5'), 'recusado', null, 'autor_sem_vinculo', 'x', 'permanent') c),
          'dead_letter', '51. recusa antes do despacho é terminal');
select ok(exists (select 1 from public.eventos_auditoria_sistema where acao = 'chatwoot.send_rejected'
                   and metadata ->> 'motivo' = 'autor_sem_vinculo'), '52. recusa auditada com o código');

-- ---------------------------------------------------------------------------
-- Invariantes.
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.chatwoot_envios set conteudo = 'trocado' where command_id = 'c8000000-0000-4000-8000-000000000001' $$,
                 '23514', null, '53. a intenção é imutável');
select throws_ok($$ select * from public.concluir_envio_chatwoot(
                       (select id from public.outbox_eventos where idempotency_key = 'chatwoot_msg_legado_1'), 'w-x', 1, 'recusado',
                       null, 'x', 'x', 'permanent') $$,
                 '22023', null, '54. evento sem intenção não é concluído por aqui');
select evento_id from public.registrar_evento_outbox('e8000000-0000-4000-8000-00000000000b', 'e8000000-0000-4000-8000-0000000000d1',
    'e8000000-0000-4000-8000-0000000000b1', 'chatwoot_msg_b_avulso', 'chatwoot', 'message.send', '{}'::jsonb, 5);
select throws_ok($$ insert into public.chatwoot_envios (organizacao_id, conexao_id, conversa_id_local, command_id, payload_digest, conteudo, ator_id, outbox_evento_id)
                    values ('e8000000-0000-4000-8000-00000000000b', 'e8000000-0000-4000-8000-0000000000d1',
                            (select valor::uuid from t_ctx where nome = 'a1'), gen_random_uuid(), repeat('a', 64), 'x',
                            'e8000000-0000-4000-8000-0000000000b1',
                            (select id from public.outbox_eventos where idempotency_key = 'chatwoot_msg_b_avulso')) $$,
                 '23503', null, '55. intenção não aponta para conversa ou evento de outra organização');
select is((select count(*)::int from public.outbox_eventos where idempotency_key like 'chatwoot_msg_legado%' and status <> 'pending'),
          0, '56. o backlog inline continua intocado');

select * from finish();
rollback;
