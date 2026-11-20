-- MSG-022. Fixtures exercise the real inbox, claim, fencing and outbox RPCs.
begin;
select plan(68);
set local request.jwt.claim.role = 'service_role';

insert into auth.users (id, email) values
    ('e2200000-0000-4000-8000-0000000000a1', 'owner-a-22@orbita.test'),
    ('e2200000-0000-4000-8000-0000000000a2', 'member-a-22@orbita.test'),
    ('e2200000-0000-4000-8000-0000000000b1', 'owner-b-22@orbita.test'),
    ('e2200000-0000-4000-8000-0000000000f1', 'ops-22@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('e2200000-0000-4000-8000-00000000000a', 'Msg22 A', 'msg22-a', 'active'),
    ('e2200000-0000-4000-8000-00000000000b', 'Msg22 B', 'msg22-b', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('e2200000-0000-4000-8000-00000000000a', 'e2200000-0000-4000-8000-0000000000a1', 'owner'),
    ('e2200000-0000-4000-8000-00000000000a', 'e2200000-0000-4000-8000-0000000000a2', 'member'),
    ('e2200000-0000-4000-8000-00000000000b', 'e2200000-0000-4000-8000-0000000000b1', 'owner');
insert into public.sac_operadores_autorresposta (ator_id) values ('e2200000-0000-4000-8000-0000000000f1');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('e2200000-0000-4000-8000-0000000000c1', 'e2200000-0000-4000-8000-00000000000a', 'chatwoot', 'A', 'conectado'),
    ('e2200000-0000-4000-8000-0000000000d1', 'e2200000-0000-4000-8000-00000000000b', 'chatwoot', 'B', 'conectado');

create function pg_temp.id(p_sufixo text) returns uuid language sql immutable as $$
    select ('e2200000-0000-4000-8000-' || lpad(p_sufixo, 12, '0'))::uuid
$$;

create function pg_temp.inbox(p_org uuid, p_conexao uuid, p_msg int, p_conv int, p_criada_em timestamptz default null)
returns text language plpgsql as $$
declare
    v_evento uuid;
    v_token bigint;
begin
    select evento_id into v_evento from public.aceitar_entrega_inbox_chatwoot(
        p_org, p_conexao, null, 1, null, 'm22-' || p_msg, 'message_created', '{"event":"x"}'::jsonb);
    select r.fencing_token into v_token
      from public.reivindicar_eventos_inbox_chatwoot('w-inbox', 50, 60, 'epoch'::timestamptz) r
     where r.evento_id = v_evento;
    return (select a.disposicao from public.aplicar_evento_inbox_chatwoot(v_evento, 'w-inbox', v_token,
        jsonb_build_object(
            'evento', 'message_created', 'acao', 'espelhar', 'account_id', '1', 'abre_caso', true, 'revisao_conteudo_em', null,
            'contato', jsonb_build_object('id', 5, 'nome', 'Contato'),
            'conversa', jsonb_build_object('id', p_conv, 'contato_id', 5, 'status', 'open', 'inbox_id', 1, 'canal', 'Channel::Api'),
            'mensagem', jsonb_build_object('id', p_msg, 'conversa_id', p_conv, 'conteudo', 'texto', 'tipo', 'incoming',
                                           'remetente_tipo', 'contact', 'modo', 'preservar', 'criada_em', p_criada_em))) a);
end;
$$;

create function pg_temp.conversa(p_conv int) returns uuid language sql as $$
    select id_local from public.chatwoot_conversations where id_externo = p_conv::text
      and organizacao_id in (pg_temp.id('a'), pg_temp.id('b'));
$$;

create function pg_temp.mudar(p_org uuid, p_ator uuid, p_ativa boolean, p_v bigint) returns text language sql as $$
    select public.alterar_politica_autorresposta(p_org, p_ator, p_ativa, p_v, 'ensaio local')
$$;

create function pg_temp.caso(p_conversa int) returns uuid language sql as $$
    select id from public.sac_cases where conversa_id_local = pg_temp.conversa(p_conversa)
$$;

-- Fixture de resultados persistidos pelo contrato da 94, sem chamada ao modelo.
create function pg_temp.criar_run(p_conversa int, p_status text default 'concluida',
    p_humano boolean default false, p_provedor text default 'google') returns uuid language sql as $$
    insert into public.ai_runs (organizacao_id, caso_id, evento_outbox_id, fencing_token, mensagens_ate,
        provedor, modelo, versao_prompt, versao_schema, status, resultado, motivo, chamou_modelo, concluida_em)
    select c.organizacao_id, c.id, o.id, 1 + coalesce((select max(fencing_token) from public.ai_runs where evento_outbox_id = o.id), 0),
        c.ultima_mensagem_em, p_provedor, 'flash', 'v1', 1, p_status,
        case when p_status = 'concluida' then jsonb_build_object('precisaDeHumano', p_humano) end,
        case when p_status = 'handoff' then 'recusa' end, true, now()
    from public.sac_cases c join public.outbox_eventos o on o.organizacao_id = c.organizacao_id
       and o.event_type = 'sac.triagem' and o.payload ->> 'caso_id' = c.id::text
       and (o.payload ->> 'mensagens_ate')::timestamptz = c.ultima_mensagem_em
    where c.id = pg_temp.caso(p_conversa)
    returning id
$$;

create function pg_temp.enviar(p_org uuid, p_ator uuid, p_conversa int, p_comando text, p_g bigint, p_o bigint,
    p_run uuid default null, p_caso uuid default null)
returns text language sql as $$
    select public.registrar_autorresposta_chatwoot(p_org, p_ator, pg_temp.conversa(p_conversa),
        coalesce(p_caso, pg_temp.caso(p_conversa)), pg_temp.id(p_comando),
        coalesce(p_run, (select id from public.ai_runs where caso_id = pg_temp.caso(p_conversa) order by sequencia desc limit 1)),
        'Resposta sintetica', p_g, p_o, 0)
$$;
create function pg_temp.evento(p_comando text) returns uuid language sql as $$
    select outbox_evento_id from public.chatwoot_envios where command_id = pg_temp.id(p_comando)
$$;

create function pg_temp.estado(p_comando text) returns text language sql as $$
    select status from public.outbox_eventos where id = pg_temp.evento(p_comando)
$$;

select ok(not has_function_privilege('authenticated',
    'public.registrar_autorresposta_chatwoot(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,bigint,bigint)', 'execute'),
    'browser sem autoridade para registrar IA');
select ok(not has_function_privilege('authenticated',
    'public.alterar_politica_autorresposta(uuid,uuid,boolean,bigint,text)', 'execute'), 'browser sem acesso direto');
select ok(not has_table_privilege('service_role', 'public.sac_operadores_autorresposta', 'insert'), 'elevação exige operador do banco');
select is(pg_temp.inbox(pg_temp.id('a'), pg_temp.id('c1'), 2201, 221), 'caso_aberto', 'inbox A abre caso com IA desligada');
select is(pg_temp.inbox(pg_temp.id('b'), pg_temp.id('d1'), 2202, 222), 'caso_aberto', 'inbox B abre caso');
insert into public.chatwoot_conversa_controle (organizacao_id, conversa_id_local, ownership_mode)
select organizacao_id, id_local, 'AI' from public.chatwoot_conversations
 where id_local in (pg_temp.conversa(221), pg_temp.conversa(222));
insert into public.sac_executores_autorresposta values
    (pg_temp.id('a'),pg_temp.id('a1')), (pg_temp.id('b'),pg_temp.id('b1'));
-- Explicitly released fixtures; the initial real rehearsal remains conversation-restricted.
insert into public.chatwoot_ai_runtime (conexao_id,organizacao_id,executor_id,inbox_id,corte,ativo,pronto_ate,clientes_liberados) values
    (pg_temp.id('c1'),pg_temp.id('a'),pg_temp.id('a1'),1,now(),true,now()+interval '10 minutes',true),
    (pg_temp.id('d1'),pg_temp.id('b'),pg_temp.id('b1'),1,now(),true,now()+interval '10 minutes',true);
insert into public.chatwoot_ai_projecao (organizacao_id,conversa_id,versao,desejado,fase)
select organizacao_id,id_local,0,'pending','ok' from public.chatwoot_conversations
 where id_local in (pg_temp.conversa(221),pg_temp.conversa(222));
do $$ begin perform pg_temp.criar_run(221); perform pg_temp.criar_run(222); end $$;
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '101', 0, 0), 'desligada', 'default fechado');
select is(pg_temp.mudar(null, pg_temp.id('a1'), true, 0), 'sem_permissao', 'owner não é operador global');
select is(pg_temp.mudar(pg_temp.id('b'), pg_temp.id('a1'), true, 0), 'sem_permissao', 'owner A não escreve B');
select is(pg_temp.mudar(pg_temp.id('a'), pg_temp.id('a2'), true, 0), 'sem_permissao', 'membro não administra');
select throws_ok(format('select public.ler_politica_autorresposta(%L, %L)', pg_temp.id('b'), pg_temp.id('a1')),
    '42501', 'Sem permissao para autorresposta.', 'owner A não lê B');
select is(pg_temp.mudar(null, pg_temp.id('f1'), true, 0), 'aplicado', 'operador liga global');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '101', 1, 0), 'desligada', 'global sozinho não permite');
select is(pg_temp.mudar(pg_temp.id('a'), pg_temp.id('a1'), true, 0), 'aplicado', 'liga A');
select is(pg_temp.mudar(pg_temp.id('b'), pg_temp.id('b1'), true, 0), 'aplicado', 'liga B');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 222, '101', 1, 1), 'conexao_indisponivel', 'conversa fora do tenant');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '101', 1, 1), 'registrada', 'registra IA A');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '101', 1, 1), 'existente', 'retry da intenção é idempotente');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '102', 1, 1), 'registrada', 'outra intenção A');
select is(pg_temp.enviar(pg_temp.id('b'), pg_temp.id('b1'), 222, '103', 1, 1), 'registrada', 'registra IA B');

create temp table leases22 as select evento_id, fencing_token from
    public.reivindicar_envios_chatwoot('w22', 50, 120, 'epoch', 2);
select is(public.iniciar_envio_chatwoot(pg_temp.evento('101'), 'w22',
    (select fencing_token from leases22 where evento_id = pg_temp.evento('101'))), 'iniciado', 'primeira A em voo');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '107', 1, 1), 'registrada', 'A pendente sem claim');
select is(pg_temp.mudar(pg_temp.id('a'), pg_temp.id('a1'), false, 1), 'aplicado', 'desliga A');
select is(pg_temp.mudar(pg_temp.id('a'), pg_temp.id('a1'), true, 1), 'conflito', 'CAS impede sobrepor desligamento');
select is(pg_temp.estado('107'), 'dead_letter', 'pendente A foi invalidado');
select is(pg_temp.estado('102'), 'dead_letter', 'claim A sem dispatch foi invalidado');
select is(pg_temp.estado('101'), 'in_flight', 'A em voo permanece');
select is(pg_temp.estado('103'), 'processing', 'B permanece disponível');
select is(public.iniciar_envio_chatwoot(pg_temp.evento('102'), 'w22',
    (select fencing_token from leases22 where evento_id = pg_temp.evento('102'))), 'posse_perdida', 'token pré-desligamento não envia');
select is((select status from public.concluir_envio_chatwoot(pg_temp.evento('101'), 'w22',
    (select fencing_token from leases22 where evento_id = pg_temp.evento('101')),
    'desconhecido', null, 'timeout')), 'unknown', 'efeito em voo continua reconciliável');

select is(public.resolver_evento_desconhecido_outbox(pg_temp.id('a'), pg_temp.evento('101'),
    pg_temp.id('a1'), 'provado_nao_aplicado', null, 'prova sintetica sem efeito'), 'unknown', 'preserva prova de nao aplicacao');
select throws_ok(format('select public.autorizar_replay_outbox(%L, %L, %L)',
    pg_temp.id('a'), pg_temp.evento('101'), pg_temp.id('a1')), '55000',
    'Autorresposta exige nova geracao apos reconciliacao.', 'replay IA exige geracao nova');
select is(public.resolver_evento_desconhecido_outbox(pg_temp.id('a'), pg_temp.evento('101'),
    pg_temp.id('a1'), 'confirmado', '222221'), 'sent', 'recibo permite reconciliar efeito IA');
select is(pg_temp.mudar(pg_temp.id('a'), pg_temp.id('a1'), true, 2), 'aplicado', 'religa A');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '104', 1, 1), 'obsoleta', 'geração antiga não registra');
select is(pg_temp.estado('102'), 'dead_letter', 'reabilitar não revive');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '108', 1, 3), 'registrada', 'trabalho novo autorizado');
create temp table takeover22 as select evento_id, fencing_token from
    public.reivindicar_envios_chatwoot('takeover22', 50, 120, 'epoch', 2);
select is((select resultado from public.registrar_envio_chatwoot(pg_temp.id('a'), pg_temp.id('a2'),
    pg_temp.conversa(221), pg_temp.id('105'), 'resposta humana')), 'registrado', 'humano assume e enfileira');
select is(public.iniciar_envio_chatwoot(pg_temp.evento('108'), 'takeover22',
    (select fencing_token from takeover22 where evento_id = pg_temp.evento('108'))), 'invalidado', 'takeover protege claim IA');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 221, '106', 1, 3), 'obsoleta', 'takeover impede registrar IA');
select is(pg_temp.mudar(null, pg_temp.id('f1'), false, 1), 'aplicado', 'desligamento global');
select is(pg_temp.estado('103'), 'dead_letter', 'global invalida B');
select is(pg_temp.estado('105'), 'pending', 'pendência humana não muda');
create temp table humano22 as select evento_id, fencing_token from
    public.reivindicar_envios_chatwoot('humano22', 50, 120, 'epoch', 2);
select is(public.iniciar_envio_chatwoot(pg_temp.evento('105'), 'humano22',
    (select fencing_token from humano22 where evento_id = pg_temp.evento('105'))), 'iniciado', 'humano despacha com IA desligada');
select is((select status from public.concluir_envio_chatwoot(pg_temp.evento('105'), 'humano22',
    (select fencing_token from humano22 where evento_id = pg_temp.evento('105')),
    'confirmado', '222222')), 'sent', 'recibo humano fecha outbox');
select is(pg_temp.inbox(pg_temp.id('a'), pg_temp.id('c1'), 2203, 223), 'caso_aberto', 'inbound continua após desligar');
select is((select count(*)::integer from public.sac_historico_autorresposta), 6, 'apenas comandos aplicados são auditados');
select is((select count(*)::integer from public.chatwoot_envios where autorresposta_run_id is not null), 5,
    'registros da autorresposta preservados');

select is(pg_temp.mudar(null, pg_temp.id('f1'), true, 2), 'aplicado', 'religa global para ensaios de proveniencia');
select is(pg_temp.inbox(pg_temp.id('a'), pg_temp.id('c1'), 2204, 224), 'caso_aberto', 'segundo caso A');
select is(pg_temp.inbox(pg_temp.id('a'), pg_temp.id('c1'), 2205, 225), 'caso_aberto', 'terceiro caso A');
insert into public.chatwoot_conversa_controle (organizacao_id, conversa_id_local, ownership_mode)
select organizacao_id, id_local, 'AI' from public.chatwoot_conversations
 where id_local in (pg_temp.conversa(224), pg_temp.conversa(225));
insert into public.chatwoot_ai_projecao (organizacao_id,conversa_id,versao,desejado,fase)
select organizacao_id,id_local,0,'pending','ok' from public.chatwoot_conversations
 where id_local in (pg_temp.conversa(224),pg_temp.conversa(225));

select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '201', 3, 3, pg_temp.id('999')),
    'run_inelegivel', 'run inexistente não gera intenção');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '202', 3, 3,
    (select id from public.ai_runs where caso_id = pg_temp.caso(222))),
    'run_inelegivel', 'run existente de B não gera intenção A');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '203', 3, 3,
    (select id from public.ai_runs where caso_id = pg_temp.caso(221)), pg_temp.caso(221)),
    'run_inelegivel', 'caso e run de outra conversa do mesmo tenant');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '209', 3, 3,
    (select id from public.ai_runs where caso_id = pg_temp.caso(221))),
    'run_inelegivel', 'run de outro caso com caso e conversa corretos na entrada');

create temp table runs22 (nome text primary key, id uuid);
insert into runs22 values
    ('handoff', pg_temp.criar_run(224, 'handoff')),
    ('humano', pg_temp.criar_run(224, 'concluida', true)),
    ('fake', pg_temp.criar_run(224, 'concluida', false, 'fake')),
    ('valido', pg_temp.criar_run(224)),
    ('revogar', pg_temp.criar_run(225));
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '204', 3, 3,
    (select id from runs22 where nome = 'handoff')), 'run_inelegivel', 'handoff não pode autorizar');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '205', 3, 3,
    (select id from runs22 where nome = 'humano')), 'run_inelegivel', 'resultado pede humano');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '206', 3, 3,
    (select id from runs22 where nome = 'fake')), 'run_inelegivel', 'simulação permanece local');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a2'), 224, '207', 3, 3),
    'executor_nao_autorizado', 'membro comum não pode despachar IA');
select ok(not has_table_privilege('service_role', 'public.sac_executores_autorresposta', 'insert'),
    'cliente privilegiado não promove executores');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '208', 3, 3),
    'registrada', 'run presente, designado, conclusivo e vigente');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 225, '210', 3, 3),
    'registrada', 'segundo envio reivindicável');
create temp table leases_prev22 as select evento_id, fencing_token
    from public.reivindicar_envios_chatwoot('contexto22', 50, 120, 'epoch', 2);

select is(pg_temp.inbox(pg_temp.id('a'), pg_temp.id('c1'), 2206, 224, '2000-01-01'),
    'mensagem_no_caso', 'aplica nova mensagem mesmo fora de ordem');
select ok((select c.ultima_mensagem_em > r.mensagens_ate from public.sac_cases c
    join public.ai_runs r on r.caso_id = c.id where r.id = (select id from runs22 where nome = 'valido')),
    'mensagem atrasada avança o marcador usado pela 94');
select is(pg_temp.enviar(pg_temp.id('a'), pg_temp.id('a1'), 224, '211', 3, 3),
    'run_inelegivel', 'run da versão anterior foi fechado para registro');
select is(public.iniciar_envio_chatwoot(pg_temp.evento('208'), 'contexto22',
    (select fencing_token from leases_prev22 where evento_id = pg_temp.evento('208'))),
    'invalidado', 'versão foi revalidada na fronteira do POST');
select is((select count(*)::int from public.outbox_tentativas where evento_id = pg_temp.evento('208')),
    0, 'nenhuma tentativa de rede aberta para contexto obsoleto');
delete from public.sac_executores_autorresposta where (organizacao_id, ator_id) = (pg_temp.id('a'), pg_temp.id('a1'));
select is(public.iniciar_envio_chatwoot(pg_temp.evento('210'), 'contexto22',
    (select fencing_token from leases_prev22 where evento_id = pg_temp.evento('210'))),
    'invalidado', 'revogação após claim impede despacho apesar do membership');
select is((select count(*)::int from public.chatwoot_envios
    where command_id in (pg_temp.id('201'), pg_temp.id('202'), pg_temp.id('203'), pg_temp.id('204'),
        pg_temp.id('205'), pg_temp.id('206'), pg_temp.id('207'), pg_temp.id('209'), pg_temp.id('211'))),
    0, 'recusas não criam intenções');
select * from finish();
rollback;
