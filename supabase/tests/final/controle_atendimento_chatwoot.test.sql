-- controle_atendimento_chatwoot.test.sql
-- MSG-009, contra o schema canônico completo: uma conversa tem um único dono
-- lógico; assumir, devolver e exigir humano são compare-and-set na versão;
-- cada mudança invalida o que está na fila; o worker confere a versão antes de
-- gravar `in_flight`; nota privada nunca vira mensagem espelhada. A corrida
-- real entre takeover e despacho está em scripts/database-concurrency-controle-chatwoot.mjs.

begin;

select plan(85);

set local request.jwt.claim.role = 'service_role';

insert into auth.users (id, email) values
    ('e9000000-0000-4000-8000-0000000000a1', 'atendente-1-m9@orbita.test'),
    ('e9000000-0000-4000-8000-0000000000a2', 'atendente-2-m9@orbita.test'),
    ('e9000000-0000-4000-8000-0000000000a0', 'dona-a-m9@orbita.test'),
    ('e9000000-0000-4000-8000-0000000000b1', 'dona-b-m9@orbita.test'),
    ('e9000000-0000-4000-8000-0000000000b2', 'atendente-b-m9@orbita.test'),
    ('e9000000-0000-4000-8000-0000000000b3', 'atendente-b3-m9@orbita.test'),
    ('e9000000-0000-4000-8000-0000000000f1', 'fora-m9@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('e9000000-0000-4000-8000-00000000000a', 'Org A M9', 'org-a-m9', 'active'),
    ('e9000000-0000-4000-8000-00000000000b', 'Org B M9', 'org-b-m9', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1', 'member'),
    ('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2', 'member'),
    ('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a0', 'owner'),
    ('e9000000-0000-4000-8000-00000000000b', 'e9000000-0000-4000-8000-0000000000b1', 'owner'),
    ('e9000000-0000-4000-8000-00000000000b', 'e9000000-0000-4000-8000-0000000000b2', 'member'),
    ('e9000000-0000-4000-8000-00000000000b', 'e9000000-0000-4000-8000-0000000000b3', 'member');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('e9000000-0000-4000-8000-0000000000c1', 'e9000000-0000-4000-8000-00000000000a', 'chatwoot', 'A1', 'conectado'),
    ('e9000000-0000-4000-8000-0000000000d1', 'e9000000-0000-4000-8000-00000000000b', 'chatwoot', 'B1', 'conectado');

create temp table t_ctx (nome text primary key, valor text) on commit drop;

create function pg_temp.inbox(p_org uuid, p_conexao uuid, p_chave text, p_msg int, p_conv int)
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
            'evento', 'message_created', 'acao', 'espelhar', 'account_id', '1', 'abre_caso', true, 'revisao_conteudo_em', null,
            'contato', jsonb_build_object('id', 5, 'nome', 'Contato'),
            'conversa', jsonb_build_object('id', p_conv, 'contato_id', 5, 'status', 'open', 'inbox_id', 1, 'canal', 'Channel::Api'),
            'mensagem', jsonb_build_object('id', p_msg, 'conversa_id', p_conv, 'conteudo', 'texto', 'tipo', 'incoming',
                                           'remetente_tipo', 'contact', 'modo', 'preservar'))) a);
end;
$$;

create function pg_temp.conversa(p_conexao uuid, p_conv int)
returns uuid language sql as $$
    select id_local from public.chatwoot_conversations where conexao_id = p_conexao and id_externo = p_conv::text;
$$;

create function pg_temp.enviar(p_org uuid, p_ator uuid, p_conversa uuid, p_comando uuid, p_texto text)
returns text language sql as $$
    select resultado from public.registrar_envio_chatwoot(p_org, p_ator, p_conversa, p_comando, p_texto);
$$;

create function pg_temp.alterar(p_org uuid, p_ator uuid, p_conversa uuid, p_comando uuid, p_acao text, p_versao bigint,
                                p_nota text default null)
returns text language sql as $$
    select resultado from public.alterar_controle_atendimento_chatwoot(p_org, p_ator, p_conversa, p_comando, p_acao, p_versao, p_nota);
$$;

create function pg_temp.controle(p_conversa uuid)
returns text language sql as $$
    select ownership_mode || ':' || coalesce(responsavel_id::text, '-') || ':' || control_version
      from public.chatwoot_conversa_controle where conversa_id_local = p_conversa;
$$;

create function pg_temp.evento(p_org uuid, p_comando uuid)
returns uuid language sql as $$
    select outbox_evento_id from public.chatwoot_envios where organizacao_id = p_org and command_id = p_comando;
$$;

create function pg_temp.token(p_evento uuid, p_worker text)
returns bigint language sql as $$
    select r.fencing_token from public.reivindicar_envios_chatwoot(p_worker, 50, 60, 'epoch', 2) r where r.evento_id = p_evento;
$$;

select pg_temp.inbox('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000c1', 'm9-a-1', 9101, 70);
select pg_temp.inbox('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000c1', 'm9-a-2', 9102, 71);
select pg_temp.inbox('e9000000-0000-4000-8000-00000000000b', 'e9000000-0000-4000-8000-0000000000d1', 'm9-b-1', 9101, 70);
insert into t_ctx values
    ('a', pg_temp.conversa('e9000000-0000-4000-8000-0000000000c1', 70)::text),
    ('a71', pg_temp.conversa('e9000000-0000-4000-8000-0000000000c1', 71)::text),
    ('b', pg_temp.conversa('e9000000-0000-4000-8000-0000000000d1', 70)::text);

-- ---------------------------------------------------------------------------
-- Superfície.
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.chatwoot_conversa_controle'::regclass), '1. controle com RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.chatwoot_controle_historico'::regclass), '2. histórico com RLS');
select ok(not has_table_privilege('authenticated', 'public.chatwoot_conversa_controle', 'select')
          and not has_table_privilege('anon', 'public.chatwoot_conversa_controle', 'select')
          and not has_table_privilege('authenticated', 'public.chatwoot_controle_historico', 'select'),
          '3. navegador não lê controle nem histórico');
select ok(not has_table_privilege('service_role', 'public.chatwoot_conversa_controle', 'insert')
          and not has_table_privilege('service_role', 'public.chatwoot_conversa_controle', 'update')
          and not has_table_privilege('service_role', 'public.chatwoot_controle_historico', 'insert')
          and not has_table_privilege('service_role', 'public.chatwoot_controle_historico', 'update'),
          '4. o servidor só escreve controle e histórico pelas funções');
select ok(not has_function_privilege('authenticated', 'public.alterar_controle_atendimento_chatwoot(uuid,uuid,uuid,uuid,text,bigint,text)', 'execute')
          and not has_function_privilege('anon', 'public.iniciar_envio_chatwoot(uuid,text,bigint)', 'execute'),
          '5. navegador não altera controle nem inicia despacho');
select ok(not has_function_privilege('service_role', 'public.travar_controle_chatwoot(uuid,uuid,boolean)', 'execute')
          and not has_function_privilege('service_role', 'public.invalidar_envios_na_fila_chatwoot(uuid,uuid,bigint)', 'execute')
          and not has_function_privilege('service_role', 'public.registrar_nota_privada_chatwoot(uuid,uuid,uuid,uuid,text,bigint)', 'execute'),
          '6. auxiliares nem pelo servidor');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'reivindicar_envios_chatwoot'), 1,
          '7. só existe o claim do protocolo 2');
select throws_ok($$ select * from public.reivindicar_envios_chatwoot('w-velho', 10, 60, 'epoch', 1) $$, '22023', null,
                 '8. worker de protocolo anterior falha fechado');
select ok((select count(*) = 2 from public.catalogo_eventos_auditoria
            where nome in ('chatwoot.control_changed', 'chatwoot.send_invalidated')), '9. eventos novos no catálogo SQL');

-- ---------------------------------------------------------------------------
-- Responder conversa sem dono é assumi-la; outra pessoa não responde.
-- ---------------------------------------------------------------------------
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')), null, '10. sem ação, nenhuma linha de controle');
select is(pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                         (select valor::uuid from t_ctx where nome = 'a'), 'c9000000-0000-4000-8000-000000000001', 'primeira'),
          'registrado', '11. A1 responde conversa sem dono');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')),
          'HUMAN:e9000000-0000-4000-8000-0000000000a1:1', '12. responder assumiu: HUMAN, A1, versão 1');
select is((select controle_versao from public.chatwoot_envios where command_id = 'c9000000-0000-4000-8000-000000000001'), 1::bigint,
          '13. o envio leva a versão em que nasceu');
select is((select acao || ':' || modo_anterior || '>' || modo_novo from public.chatwoot_controle_historico
            where command_id = 'c9000000-0000-4000-8000-000000000001'),
          'assumir_por_envio:HUMAN_REQUIRED>HUMAN', '14. histórico registra a tomada implícita');
select is(pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                         (select valor::uuid from t_ctx where nome = 'a'), 'c9000000-0000-4000-8000-000000000002', 'segunda'),
          'registrado', '15. o dono responde de novo sem mudar a versão');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')),
          'HUMAN:e9000000-0000-4000-8000-0000000000a1:1', '16. segunda resposta não incrementa versão');
select is(pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                         (select valor::uuid from t_ctx where nome = 'a'), 'c9000000-0000-4000-8000-000000000003', 'intrusa'),
          'outro_responsavel', '17. A2 não responde conversa de A1');
select is((select count(*)::int from public.chatwoot_envios where command_id = 'c9000000-0000-4000-8000-000000000003'), 0,
          '18. outro_responsavel não grava intenção');

-- ---------------------------------------------------------------------------
-- Assumir: CAS na versão, invalida a fila, nota privada.
-- ---------------------------------------------------------------------------
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000001', 'assumir', 0),
          'conflito_versao', '19. aba com versão vencida: conflito, nada muda');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')),
          'HUMAN:e9000000-0000-4000-8000-0000000000a1:1', '20. conflito não mexe no controle');

create temp table t_assumir on commit drop as
select * from public.alterar_controle_atendimento_chatwoot(
    'e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
    (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000002', 'assumir', 1, 'Cliente pediu troca.');

select is((select resultado || ':' || ownership_mode || ':' || control_version from t_assumir), 'aplicado:HUMAN:2',
          '21. A2 assume na versão certa');
select is((select invalidados from t_assumir), 2, '22. as duas respostas de A1 na fila foram invalidadas');
select is((select count(*)::int from public.outbox_eventos o join public.chatwoot_envios e on e.outbox_evento_id = o.id
            where e.command_id in ('c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000002')
              and o.status = 'dead_letter' and e.invalidado_em is not null
              and o.last_error like 'Envio invalidado%'), 2,
          '23. invalidadas como dead_letter com motivo e marca no envio');
select is((select health_status from public.conexoes_integracao where id = 'e9000000-0000-4000-8000-0000000000c1'),
          (select health_status from public.conexoes_integracao where id = 'e9000000-0000-4000-8000-0000000000d1'),
          '24. invalidar não degrada a saúde da conexão');
select ok((select nota_envio_id is not null from t_assumir), '25. a mudança registrou nota privada');
select is((select privada::text || ':' || o.event_type from public.chatwoot_envios e
             join public.outbox_eventos o on o.id = e.outbox_evento_id
            where e.id = (select nota_envio_id from t_assumir)), 'true:message.note',
          '26. a nota é intenção privada, de outro tipo de evento');
select ok((select conteudo like '%Cliente pediu troca.%' from public.chatwoot_envios where id = (select nota_envio_id from t_assumir)),
          '27. a nota leva o texto do atendente');
select ok(not exists (select 1 from public.eventos_auditoria_sistema
                       where acao = 'chatwoot.control_changed' and metadata::text like '%Cliente pediu troca%')
          and exists (select 1 from public.eventos_auditoria_sistema
                       where acao = 'chatwoot.control_changed' and recurso_id = (select valor from t_ctx where nome = 'a')
                         and metadata ->> 'acao' = 'assumir' and metadata ->> 'versao' = '2'),
          '28. a trilha registra a mudança sem o texto da nota');
select is((select count(*)::int from public.eventos_auditoria_sistema where acao = 'chatwoot.send_invalidated'
            and organizacao_id = 'e9000000-0000-4000-8000-00000000000a'), 2, '29. cada invalidação auditada');

select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000002', 'assumir', 1,
                          'Cliente pediu troca.'),
          'existente', '30. a mesma ação repetida devolve o resultado gravado');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')),
          'HUMAN:e9000000-0000-4000-8000-0000000000a2:2', '31. repetir não incrementa versão');
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000002', 'assumir', 1,
                          'outra nota'),
          'conflito_comando', '32. mesmo comando com outra nota é conflito');
select is(pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                         (select valor::uuid from t_ctx where nome = 'a'), 'c9000000-0000-4000-8000-000000000001', 'primeira'),
          'existente', '33. a repetição do envio antigo de A1 continua idempotente');
select is(pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                         (select valor::uuid from t_ctx where nome = 'a'), 'c9000000-0000-4000-8000-000000000004', 'nova'),
          'outro_responsavel', '34. A1 perdeu a conversa: resposta nova recusada');
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000003', 'assumir', 2),
          'transicao_invalida', '35. assumir o que já é seu não muda nada');

-- ---------------------------------------------------------------------------
-- Devolver e exigir humano.
-- ---------------------------------------------------------------------------
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000004', 'devolver', 2,
                          'Resolvido.'),
          'sem_capacidade', '36. membro não devolve à automação');
select throws_ok($$ select public.alterar_controle_atendimento_chatwoot('e9000000-0000-4000-8000-00000000000a',
                       'e9000000-0000-4000-8000-0000000000a0', (select valor::uuid from t_ctx where nome = 'a'),
                       'd9000000-0000-4000-8000-000000000005', 'devolver', 2, null) $$, '22023', null,
                 '37. devolver sem resumo é comando inválido');
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a0',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000006', 'devolver', 2,
                          'Resolvido.'),
          'transicao_invalida', '38. só o dono devolve');
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a0',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000007', 'assumir', 2),
          'aplicado', '39. a dona assume');
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a0',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000008', 'devolver', 3,
                          'Pedido localizado, aguardando cliente.'),
          'aplicado', '40. a dona devolve com resumo');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')), 'AI:-:4', '41. automação, sem dono, versão 4');
select is((select nota from public.chatwoot_controle_historico where command_id = 'd9000000-0000-4000-8000-000000000008'),
          'Pedido localizado, aguardando cliente.', '42. o resumo fica no histórico do ORBITA');
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000009', 'exigir_humano', 4),
          'aplicado', '43. qualquer atendente exige humano');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')), 'HUMAN_REQUIRED:-:5', '44. aguardando humano, versão 5');
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-00000000000a', 'exigir_humano', 5),
          'transicao_invalida', '45. exigir humano só vale saindo da automação');

-- ---------------------------------------------------------------------------
-- Isolamento e vínculo.
-- ---------------------------------------------------------------------------
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000b', 'e9000000-0000-4000-8000-0000000000b1',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-0000000000b1', 'assumir', 5),
          'conversa_inexistente', '46. B não alcança a conversa de A');
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000b1',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-0000000000b2', 'assumir', 5),
          'sem_vinculo', '47. dona de B na organização A: sem vínculo');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')), 'HUMAN_REQUIRED:-:5',
          '48. nenhuma tentativa de B mudou o controle de A');

-- ---------------------------------------------------------------------------
-- Início do despacho com o controle conferido.
-- ---------------------------------------------------------------------------
-- A1 responde a 71 (assume, v1) e o worker reivindica; A2 assume antes do início.
select pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                      (select valor::uuid from t_ctx where nome = 'a71'), 'c9000000-0000-4000-8000-000000000011', 'na fila');
insert into t_ctx values ('tok11', pg_temp.token(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000011'), 'w-m9')::text);
select pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                       (select valor::uuid from t_ctx where nome = 'a71'), 'd9000000-0000-4000-8000-000000000011', 'assumir', 1);
select is(public.iniciar_envio_chatwoot(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000011'),
                                        'w-m9', (select valor::bigint from t_ctx where nome = 'tok11')),
          'invalidado', '49. takeover depois do claim e antes do início: invalidado');
select is((select o.status || ':' || (e.invalidado_em is not null)::text from public.outbox_eventos o
             join public.chatwoot_envios e on e.outbox_evento_id = o.id
            where e.command_id = 'c9000000-0000-4000-8000-000000000011'), 'dead_letter:true',
          '50. invalidado sem despacho');
select is((select count(*)::int from public.outbox_tentativas
            where evento_id = pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000011')), 0,
          '51. nenhuma tentativa de rede registrada');

-- A2 responde (é dona, v2): o início passa; um takeover depois vê a resposta em voo.
select pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                      (select valor::uuid from t_ctx where nome = 'a71'), 'c9000000-0000-4000-8000-000000000012', 'vai sair');
insert into t_ctx values ('tok12', pg_temp.token(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000012'), 'w-m9')::text);
select is(public.iniciar_envio_chatwoot(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000012'),
                                        'w-m9', (select valor::bigint from t_ctx where nome = 'tok12') + 1),
          'posse_perdida', '52. token errado: posse perdida');
select is(public.iniciar_envio_chatwoot(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000012'),
                                        'w-m9', (select valor::bigint from t_ctx where nome = 'tok12')),
          'iniciado', '53. versão vigente: iniciado');

create temp table t_corrida on commit drop as
select * from public.alterar_controle_atendimento_chatwoot(
    'e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a0',
    (select valor::uuid from t_ctx where nome = 'a71'), 'd9000000-0000-4000-8000-000000000012', 'assumir', 2);
select is((select resultado || ':' || em_voo || ':' || invalidados from t_corrida), 'aplicado:1:0',
          '54. takeover com resposta em voo: aplicado, informa 1 em voo, não invalida o que já saiu');
select is((select status from public.outbox_eventos
            where id = pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000012')), 'in_flight',
          '55. a resposta em voo segue o protocolo da outbox (não é desfeita)');

-- ---------------------------------------------------------------------------
-- Nota privada: não é invalidada, não vira mensagem espelhada.
-- ---------------------------------------------------------------------------
insert into t_ctx values ('nota', (select nota_envio_id::text from t_corrida));
insert into t_ctx values ('nota_evt', (select outbox_evento_id::text from public.chatwoot_envios where id = (select valor::uuid from t_ctx where nome = 'nota')));
create temp table t_claim_nota on commit drop as
select * from public.reivindicar_envios_chatwoot('w-nota', 50, 60, 'epoch', 2) r
 where r.evento_id = (select valor::uuid from t_ctx where nome = 'nota_evt');
select is((select privada from t_claim_nota), true, '56. o claim diz ao worker que é nota privada');
select pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                       (select valor::uuid from t_ctx where nome = 'a71'), 'd9000000-0000-4000-8000-000000000013', 'assumir', 3);
select is(public.iniciar_envio_chatwoot((select valor::uuid from t_ctx where nome = 'nota_evt'), 'w-nota',
                                        (select fencing_token from t_claim_nota)),
          'iniciado', '57. nota não é invalidada por mudança posterior');
select is((select status from public.concluir_envio_chatwoot((select valor::uuid from t_ctx where nome = 'nota_evt'), 'w-nota',
                                        (select fencing_token from t_claim_nota), 'confirmado', '88001')), 'sent',
          '58. nota confirmada pelo recibo');
select ok(not exists (select 1 from public.chatwoot_messages where id_externo = '88001')
          and (select mensagem_id_local is null from public.chatwoot_envios where id = (select valor::uuid from t_ctx where nome = 'nota')),
          '59. nota confirmada não vira mensagem no espelho');

-- ---------------------------------------------------------------------------
-- Imutabilidade e pessoa removida.
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.chatwoot_envios set controle_versao = 99
                     where command_id = 'c9000000-0000-4000-8000-000000000012' $$, '23514', null,
                 '60. a versão do envio não muda');
select throws_ok($$ update public.chatwoot_envios set invalidado_em = now() - interval '1 day'
                     where command_id = 'c9000000-0000-4000-8000-000000000011' $$, '23514', null,
                 '61. a invalidação não é reescrita');

select pg_temp.enviar('e9000000-0000-4000-8000-00000000000b', 'e9000000-0000-4000-8000-0000000000b2',
                      (select valor::uuid from t_ctx where nome = 'b'), 'c9000000-0000-4000-8000-0000000000b1', 'da atendente');
delete from auth.users where id = 'e9000000-0000-4000-8000-0000000000b2';
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'b')), 'HUMAN:-:1',
          '62. pessoa removida: a conversa fica sem dono, sem herdeiro');
select is(pg_temp.enviar('e9000000-0000-4000-8000-00000000000b', 'e9000000-0000-4000-8000-0000000000b3',
                         (select valor::uuid from t_ctx where nome = 'b'), 'c9000000-0000-4000-8000-0000000000b2', 'assumo'),
          'registrado', '63. outra atendente responde e assume a conversa sem dono');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'b')),
          'HUMAN:e9000000-0000-4000-8000-0000000000b3:2', '64. a nova dona, na versão seguinte');

-- ---------------------------------------------------------------------------
-- Revisão da PR #141: fila em `failed_transient`, efeito `unknown`, despacho
-- pelo caminho genérico da outbox, responsável fora da organização, replay de
-- comando antigo, trilha sem texto privado e transferência auditada.
-- ---------------------------------------------------------------------------
select pg_temp.inbox('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000c1', 'm9-a-3', 9103, 72);
insert into t_ctx values ('a72', pg_temp.conversa('e9000000-0000-4000-8000-0000000000c1', 72)::text);

-- c21: o worker pegou e provou que não enviou (`failed_transient`, volta à fila).
select pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                      (select valor::uuid from t_ctx where nome = 'a72'), 'c9000000-0000-4000-8000-000000000021', 'vai falhar');
insert into t_ctx values ('tok21', pg_temp.token(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000021'), 'w-rev')::text);
select status from public.concluir_envio_chatwoot(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000021'),
    'w-rev', (select valor::bigint from t_ctx where nome = 'tok21'), 'nao_enviado', null, null, 'recusou conexão', 'transient', 600);
-- c23: despachou e a lease venceu (o reaper o torna `unknown`). c22: na fila,
-- registrada depois do claim (que leva tudo o que está `pending`).
select pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                      (select valor::uuid from t_ctx where nome = 'a72'), 'c9000000-0000-4000-8000-000000000023', 'talvez saiu');
insert into t_ctx values ('tok23', pg_temp.token(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000023'), 'w-rev')::text);
select public.iniciar_envio_chatwoot(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000023'),
                                     'w-rev', (select valor::bigint from t_ctx where nome = 'tok23'));
update public.outbox_eventos set lease_expires_at = now() - interval '1 second'
 where id = pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000023');
select * from public.liberar_leases_expirados_outbox();
select pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                      (select valor::uuid from t_ctx where nome = 'a72'), 'c9000000-0000-4000-8000-000000000022', 'na fila');
insert into t_ctx values ('saude_antes', (select health_status from public.conexoes_integracao where id = 'e9000000-0000-4000-8000-0000000000c1'));
insert into t_ctx values ('token21_antes', (select fencing_token::text from public.outbox_eventos
    where id = pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000021')));

create temp table t_rev on commit drop as
select * from public.alterar_controle_atendimento_chatwoot(
    'e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
    (select valor::uuid from t_ctx where nome = 'a72'), 'd9000000-0000-4000-8000-000000000021', 'assumir', 1);

select is((select resultado || ':' || invalidados from t_rev), 'aplicado:2',
          '65. takeover cancela a resposta na fila e a que voltou de failed_transient');
select is((select o.status || ':' || (e.invalidado_em is not null)::text from public.outbox_eventos o
             join public.chatwoot_envios e on e.outbox_evento_id = o.id
            where e.command_id = 'c9000000-0000-4000-8000-000000000021'), 'dead_letter:true',
          '66. failed_transient invalidado: dead_letter com marca no envio');
select ok((select fencing_token > (select valor::bigint from t_ctx where nome = 'token21_antes') and lease_owner is null
             and attempts = 1 from public.outbox_eventos
            where id = pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000021')),
          '67. a invalidação passa pelo fencing (token sobe, sem dono, tentativas intactas)');
select is((select health_status from public.conexoes_integracao where id = 'e9000000-0000-4000-8000-0000000000c1'),
          (select valor from t_ctx where nome = 'saude_antes'), '68. cancelamento administrativo não mexe na saúde da conexão');
select is((select em_voo from t_rev), 1, '69. efeito unknown conta como resposta que pode ter chegado');
select is((select o.status || ':' || (e.invalidado_em is null)::text from public.outbox_eventos o
             join public.chatwoot_envios e on e.outbox_evento_id = o.id
            where e.command_id = 'c9000000-0000-4000-8000-000000000023'), 'unknown:true',
          '70. unknown nunca vira cancelado nem volta à fila');
select is((select count(*)::int from public.eventos_auditoria_sistema where acao = 'chatwoot.send_invalidated'
            and metadata ->> 'evento_id' = pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000021')::text), 1,
          '71. invalidação do failed_transient auditada');

-- c24: claim pelo caminho genérico da outbox, sem conferir o controle.
select pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                      (select valor::uuid from t_ctx where nome = 'a72'), 'c9000000-0000-4000-8000-000000000024', 'pelo atalho');
insert into t_ctx values ('tok24', (select r.fencing_token::text from public.reivindicar_evento_outbox('e9000000-0000-4000-8000-00000000000a',
    pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000024'), 'w-generico', 60) r));
select pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a0',
                       (select valor::uuid from t_ctx where nome = 'a72'), 'd9000000-0000-4000-8000-000000000022', 'assumir', 2);
select throws_ok(format($q$ select public.iniciar_despacho_outbox(%L, 'w-generico', %s) $q$,
                        pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000024'),
                        (select valor from t_ctx where nome = 'tok24')),
                 '55000', null, '72. resposta do Chatwoot não inicia pelo despacho genérico');
select is((select status from public.outbox_eventos
            where id = pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000024')), 'processing',
          '73. nada em voo pelo atalho');
select is(public.iniciar_envio_chatwoot(pg_temp.evento('e9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000024'),
                                        'w-generico', (select valor::bigint from t_ctx where nome = 'tok24')),
          'invalidado', '74. pelo caminho do controle, a versão vencida invalida');

-- Responsável que saiu da organização não segura a conversa.
select pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a1',
                       (select valor::uuid from t_ctx where nome = 'a72'), 'd9000000-0000-4000-8000-000000000023', 'assumir', 3);
delete from public.membros_organizacao
 where organizacao_id = 'e9000000-0000-4000-8000-00000000000a' and user_id = 'e9000000-0000-4000-8000-0000000000a1';
select is(pg_temp.enviar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                         (select valor::uuid from t_ctx where nome = 'a72'), 'c9000000-0000-4000-8000-000000000025', 'assumo'),
          'registrado', '75. responsável fora da organização: outra atendente responde e assume');
select is(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a72')),
          'HUMAN:e9000000-0000-4000-8000-0000000000a2:5', '76. a nova dona, na versão seguinte');

-- Comando antigo repetido depois de transições posteriores.
select is(pg_temp.alterar('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000a2',
                          (select valor::uuid from t_ctx where nome = 'a'), 'd9000000-0000-4000-8000-000000000002', 'assumir', 1,
                          'Cliente pediu troca.'),
          'existente', '77. comando antigo repetido: existente, nada reaplicado');
select ok(pg_temp.controle((select valor::uuid from t_ctx where nome = 'a')) = 'HUMAN_REQUIRED:-:5'
          and (select count(*) = 1 from public.chatwoot_controle_historico where command_id = 'd9000000-0000-4000-8000-000000000002'),
          '78. o replay antigo não volta o controle nem duplica o histórico');

-- Trilha: nenhum texto de resposta ou nota.
select ok(not exists (select 1 from public.eventos_auditoria_sistema
                       where organizacao_id = 'e9000000-0000-4000-8000-00000000000a'
                         and acao in ('chatwoot.control_changed', 'chatwoot.send_invalidated', 'chatwoot.send_requested')
                         and (metadata ? 'conteudo' or metadata ? 'nota' or metadata::text like '%vai falhar%'
                              or metadata::text like '%Pedido localizado%')),
          '79. a trilha não carrega conteúdo nem nota');

-- Transferência: quem tinha a conversa fica registrado (por último: a coluna
-- é nova e, sem ela, este teste aborta a transação).
select is((select h.responsavel_anterior::text || ':' || (select a.metadata ->> 'transferencia' from public.eventos_auditoria_sistema a
              where a.acao = 'chatwoot.control_changed' and a.metadata ->> 'versao' = '2'
                and a.recurso_id = (select valor from t_ctx where nome = 'a72'))
             from public.chatwoot_controle_historico h where h.command_id = 'd9000000-0000-4000-8000-000000000021'),
          'e9000000-0000-4000-8000-0000000000a1:true', '80. transferência registra o responsável anterior');

-- Leitura para a tela: mesma regra das escritas.
create function pg_temp.ler(p_org uuid, p_conversa uuid)
returns text language sql as $$
    select resultado || ':' || coalesce(ownership_mode, '-') || ':' || coalesce(responsavel_id::text, '-') || ':'
           || coalesce(control_version::text, '-')
      from public.ler_controle_atendimento_chatwoot(p_org, p_conversa);
$$;
select pg_temp.inbox('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000c1', 'm9-a-4', 9104, 73);
select is(pg_temp.ler('e9000000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-0000000000ff'),
          'conversa_inexistente:-:-:-', '81. conversa inexistente: nenhum estado fictício');
select is(pg_temp.ler('e9000000-0000-4000-8000-00000000000b', (select valor::uuid from t_ctx where nome = 'a')),
          'conversa_inexistente:-:-:-', '82. conversa de outra organização: não encontrada');
select is(pg_temp.ler('e9000000-0000-4000-8000-00000000000a', pg_temp.conversa('e9000000-0000-4000-8000-0000000000c1', 73)),
          'encontrada:HUMAN_REQUIRED:-:0', '83. conversa sem controle: aguardando atendente, versão 0');
select is(pg_temp.ler('e9000000-0000-4000-8000-00000000000a', (select valor::uuid from t_ctx where nome = 'a71')),
          'encontrada:HUMAN:-:4', '84. dono que saiu da organização não aparece como responsável');
select ok(has_function_privilege('service_role', 'public.ler_controle_atendimento_chatwoot(uuid,uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.ler_controle_atendimento_chatwoot(uuid,uuid)', 'execute')
          and not has_function_privilege('anon', 'public.ler_controle_atendimento_chatwoot(uuid,uuid)', 'execute'),
          '85. só o servidor lê o controle');

select * from finish();
rollback;
