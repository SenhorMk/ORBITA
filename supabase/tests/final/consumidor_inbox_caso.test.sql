-- consumidor_inbox_caso.test.sql
-- MSG-006, contra o schema canônico completo: o consumidor da inbox do Chatwoot
-- reivindica com lease e fencing e aplica espelho, caso, auditoria e conclusão
-- numa transação. Concorrência real e quedas estão em
-- scripts/database-concurrency-consumidor-inbox.mjs.

begin;

select plan(93);

set local request.jwt.claim.role = 'service_role';

insert into auth.users (id, email) values
    ('e6000000-0000-4000-8000-0000000000a1', 'dono-a-m6@orbita.test'),
    ('e6000000-0000-4000-8000-0000000000b1', 'dono-b-m6@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('e6000000-0000-4000-8000-00000000000a', 'Org A M6', 'org-a-m6', 'active'),
    ('e6000000-0000-4000-8000-00000000000b', 'Org B M6', 'org-b-m6', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000a1', 'owner'),
    ('e6000000-0000-4000-8000-00000000000b', 'e6000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('e6000000-0000-4000-8000-0000000000c1', 'e6000000-0000-4000-8000-00000000000a', 'chatwoot', 'A1', 'conectado'),
    ('e6000000-0000-4000-8000-0000000000c2', 'e6000000-0000-4000-8000-00000000000b', 'chatwoot', 'B1', 'conectado');

create temp table t_ctx (nome text primary key, valor text) on commit drop;

-- Aceita a entrega pela mesma função do webhook e devolve o id do evento.
create function pg_temp.aceitar(p_org uuid, p_conexao uuid, p_chave text, p_tipo text default 'message_created')
returns uuid language sql as $$
    select evento_id from public.aceitar_entrega_inbox_chatwoot(
        p_org, p_conexao, null, 1, null, p_chave, p_tipo, '{"event":"x"}'::jsonb);
$$;

-- Reivindica tudo que estiver elegível para o worker; devolve o token do evento.
create function pg_temp.token(p_evento uuid, p_worker text)
returns bigint language plpgsql as $$
declare v bigint;
begin
    select r.fencing_token into v
      from public.reivindicar_eventos_inbox_chatwoot(p_worker, 50, 60, 'epoch'::timestamptz) r
     where r.evento_id = p_evento;
    return v;
end;
$$;

-- Comando de mensagem, como o app traduz.
create function pg_temp.msg(p_id int, p_conv int, p_contato int default 5, p_abre boolean default true,
                            p_evento text default 'message_created', p_modo text default 'preservar',
                            p_conteudo text default 'oi', p_revisao text default null, p_tipo text default 'incoming')
returns jsonb language sql as $$
    select jsonb_build_object(
        'evento', p_evento, 'acao', 'espelhar', 'account_id', '1', 'abre_caso', p_abre, 'revisao_conteudo_em', p_revisao,
        'contato', jsonb_build_object('id', p_contato, 'nome', 'Contato ' || p_contato),
        'conversa', jsonb_build_object('id', p_conv, 'contato_id', p_contato, 'status', 'open', 'inbox_id', 1, 'canal', 'Channel::Api'),
        'mensagem', jsonb_build_object('id', p_id, 'conversa_id', p_conv, 'conteudo', p_conteudo, 'tipo', p_tipo, 'remetente_tipo', 'contact', 'modo', p_modo));
$$;

-- Ciclo completo: aceita, reivindica e aplica; devolve a disposição.
create function pg_temp.consumir(p_org uuid, p_conexao uuid, p_chave text, p_comando jsonb)
returns text language plpgsql as $$
declare
    v_evento uuid := pg_temp.aceitar(p_org, p_conexao, p_chave, p_comando ->> 'evento');
    v_token bigint := pg_temp.token(v_evento, 'w-ciclo');
begin
    return (select a.disposicao from public.aplicar_evento_inbox_chatwoot(v_evento, 'w-ciclo', v_token, p_comando) a);
end;
$$;

-- ---------------------------------------------------------------------------
-- Superfície: nenhum cliente aciona o consumidor.
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.sac_cases'::regclass), 'sac_cases com RLS');
select ok(not has_table_privilege('authenticated', 'public.sac_cases', 'select'), 'navegador não lê sac_cases direto');
select ok(not has_table_privilege('anon', 'public.sac_cases', 'select'), 'anônimo não lê sac_cases');
select ok(not has_table_privilege('service_role', 'public.sac_cases', 'insert'), 'nem o service_role escreve no caso fora da função');
select ok(not has_table_privilege('authenticated', 'public.inbox_eventos_chatwoot', 'update'), 'navegador não escreve na inbox');
select is(
    (select count(*)::int
       from (values ('public.reivindicar_eventos_inbox_chatwoot(text,integer,integer,timestamptz)'),
                    ('public.aplicar_evento_inbox_chatwoot(uuid,text,bigint,jsonb)'),
                    ('public.registrar_falha_evento_inbox_chatwoot(uuid,text,bigint,text,boolean)'),
                    ('public.concluir_evento_inbox_chatwoot(uuid,text,jsonb,text)'),
                    ('public.preparar_replay_evento_inbox_chatwoot(uuid)')) as f(assinatura)
      cross join (values ('authenticated'), ('anon'), ('public')) as r(rolname)
      where has_function_privilege(r.rolname, f.assinatura, 'execute')),
    0, 'navegador, anônimo e public não executam nenhuma função do consumo');
select ok(has_function_privilege('service_role', 'public.aplicar_evento_inbox_chatwoot(uuid,text,bigint,jsonb)', 'execute'), 'o worker executa');

-- ---------------------------------------------------------------------------
-- Claim, lease e fencing.
-- ---------------------------------------------------------------------------
insert into t_ctx values ('e1', pg_temp.aceitar('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:100')::text);

select is((select status from public.inbox_eventos_chatwoot where id = (select valor::uuid from t_ctx where nome = 'e1')),
    'received', 'webhook só deixa received: nada de efeito no aceite');

insert into t_ctx values ('t1', pg_temp.token((select valor::uuid from t_ctx where nome = 'e1'), 'w1')::text);
select is((select valor from t_ctx where nome = 't1'), '1', 'primeiro claim: token 1');
select is(
    (select row(status, lease_owner, attempts)::text from public.inbox_eventos_chatwoot where id = (select valor::uuid from t_ctx where nome = 'e1')),
    '(processing,w1,1)', 'claim grava processing, dono e tentativa');
select is(pg_temp.token((select valor::uuid from t_ctx where nome = 'e1'), 'w2'), null, 'lease viva: outro worker não pega');

update public.inbox_eventos_chatwoot set lease_expires_at = clock_timestamp() - interval '1 second'
 where id = (select valor::uuid from t_ctx where nome = 'e1');
select is(
    (select desfecho from public.aplicar_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e1'), 'w1', 1, pg_temp.msg(100, 10))),
    'posse_perdida', 'lease vencida: nem o dono aplica');

insert into t_ctx values ('t2', pg_temp.token((select valor::uuid from t_ctx where nome = 'e1'), 'w2')::text);
select is((select valor from t_ctx where nome = 't2'), '2', 'retomada depois da lease: token sobe');
select is(
    (select desfecho from public.aplicar_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e1'), 'w1', 1, pg_temp.msg(100, 10))),
    'posse_perdida', 'worker antigo cercado na aplicação');
select is(
    (select desfecho from public.aplicar_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e1'), 'w2', 1, pg_temp.msg(100, 10))),
    'posse_perdida', 'o mesmo id com token velho também é cercado');
select is(
    public.registrar_falha_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e1'), 'w1', 1, 'falha_x', false),
    null, 'worker antigo não grava falha');
select is((select count(*)::int from public.sac_cases where organizacao_id = 'e6000000-0000-4000-8000-00000000000a'), 0, 'cercados não deixaram caso');
select is((select count(*)::int from public.chatwoot_messages where organizacao_id = 'e6000000-0000-4000-8000-00000000000a'), 0, 'cercados não deixaram espelho');

-- ---------------------------------------------------------------------------
-- Caminho feliz: tudo na mesma transação.
-- ---------------------------------------------------------------------------
select is(
    (select disposicao from public.aplicar_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e1'), 'w2', 2, pg_temp.msg(100, 10))),
    'caso_aberto', 'dono vigente abre o caso');
select is(
    (select row(status, disposicao, lease_owner, last_error)::text from public.inbox_eventos_chatwoot where id = (select valor::uuid from t_ctx where nome = 'e1')),
    '(processed,caso_aberto,,)', 'inbox concluída e sem lease');
select is(
    (select row(s.phase, s.version, s.ator_tipo, s.ator_ref, s.organizacao_id)::text
       from public.sac_cases s where s.evento_origem_id = (select valor::uuid from t_ctx where nome = 'e1')),
    '(TRIAGE,1,system,worker:inbox_chatwoot,e6000000-0000-4000-8000-00000000000a)', 'caso em TRIAGE, ator de sistema, organização da inbox');
select is(
    (select e.caso_id from public.inbox_eventos_chatwoot e where e.id = (select valor::uuid from t_ctx where nome = 'e1')),
    (select s.id from public.sac_cases s where s.evento_origem_id = (select valor::uuid from t_ctx where nome = 'e1')),
    'inbox aponta o caso');
select is(
    (select count(*)::int from public.eventos_auditoria_sistema a
      where a.acao = 'sac.case_opened' and a.organizacao_id = 'e6000000-0000-4000-8000-00000000000a' and a.actor_id is null),
    1, 'auditoria na mesma transação, sem ator humano');
select is(
    (select a.metadata ->> 'fase' from public.eventos_auditoria_sistema a where a.acao = 'sac.case_opened' limit 1),
    'TRIAGE', 'metadata da auditoria');
select ok(
    (select not (a.metadata::text ~ '"(content|conteudo|payload|nome)"') from public.eventos_auditoria_sistema a where a.acao = 'sac.case_opened' limit 1),
    'auditoria sem conteúdo');
select is(
    (select row(c.conexao_id, v.conexao_id, m.conexao_id, v.contato_id_local = c.id_local, m.conversa_id_local = v.id_local)::text
       from public.chatwoot_messages m
       join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
       join public.chatwoot_contacts c on c.id_local = v.contato_id_local
      where m.id_externo = '100' and m.organizacao_id = 'e6000000-0000-4000-8000-00000000000a'),
    '(e6000000-0000-4000-8000-0000000000c1,e6000000-0000-4000-8000-0000000000c1,e6000000-0000-4000-8000-0000000000c1,t,t)',
    'contato, conversa e mensagem na conexão certa, ligados pelo UUID');
select is(
    (select count(*)::int from public.chatwoot_inboxes i where i.conexao_id = 'e6000000-0000-4000-8000-0000000000c1' and i.inbox_id = 1),
    1, 'mapping da inbox entra na transação');

-- Redelivery depois de processado.
select is(
    (select a.duplicata from public.aceitar_entrega_inbox_chatwoot(
        'e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', null, 1, null,
        'v2:message_created:msg:100', 'message_created', '{"event":"x"}'::jsonb) a),
    'evento', 'redelivery é duplicata');
select is(pg_temp.token((select valor::uuid from t_ctx where nome = 'e1'), 'w3'), null, 'concluído não volta a ser reivindicado');
select is(
    (select desfecho from public.aplicar_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e1'), 'w2', 2, pg_temp.msg(100, 10))),
    'posse_perdida', 'reaplicar o concluído é recusado, mesmo com o token certo');
select is((select count(*)::int from public.sac_cases where organizacao_id = 'e6000000-0000-4000-8000-00000000000a'), 1, 'um caso depois de tudo isso');

-- ---------------------------------------------------------------------------
-- A regra do caso.
-- ---------------------------------------------------------------------------
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:101', pg_temp.msg(101, 10)),
    'mensagem_no_caso', 'segunda mensagem da conversa não abre outro caso');
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:102', pg_temp.msg(102, 10, 5, false, p_tipo => 'outgoing')),
    'espelho_atualizado', 'resposta de atendente só espelha');
select is((select count(*)::int from public.sac_cases where organizacao_id = 'e6000000-0000-4000-8000-00000000000a'), 1, 'continua um caso');

-- A mesma mensagem por outra chave (chave legada, por exemplo).
update public.sac_cases set phase = 'CLOSED' where organizacao_id = 'e6000000-0000-4000-8000-00000000000a';
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'legada:msg:100', pg_temp.msg(100, 10)),
    'mensagem_no_caso', 'mensagem que já abriu caso não abre outro, mesmo com o caso fechado');
select is((select count(*)::int from public.sac_cases where organizacao_id = 'e6000000-0000-4000-8000-00000000000a'), 1, 'uma mensagem lógica, um caso');

-- Mensagem nova depois do caso fechado: outro caso, ligado ao anterior.
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:103', pg_temp.msg(103, 10)),
    'caso_aberto', 'mensagem nova depois de fechado abre outro caso');
select is(
    (select s.caso_anterior_id from public.sac_cases s where s.phase = 'TRIAGE' and s.organizacao_id = 'e6000000-0000-4000-8000-00000000000a'),
    (select s.id from public.sac_cases s where s.phase = 'CLOSED' and s.organizacao_id = 'e6000000-0000-4000-8000-00000000000a'),
    'ligado ao caso anterior');

select throws_ok(
    $$insert into public.sac_cases (organizacao_id, conversa_id_local)
      select s.organizacao_id, s.conversa_id_local from public.sac_cases s where s.phase = 'TRIAGE'$$,
    '23505', null, 'o banco barra o segundo caso aberto da conversa');
select throws_ok(
    $$insert into public.sac_cases (organizacao_id, conversa_id_local, mensagem_origem_id_local, phase)
      select s.organizacao_id, s.conversa_id_local, s.mensagem_origem_id_local, 'CLOSED' from public.sac_cases s where s.phase = 'TRIAGE'$$,
    '23505', null, 'o banco barra a mesma origem em outro caso');

-- ---------------------------------------------------------------------------
-- Organizações.
-- ---------------------------------------------------------------------------
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000b', 'e6000000-0000-4000-8000-0000000000c2', 'v2:message_created:msg:100', pg_temp.msg(100, 10)),
    'caso_aberto', 'B com os mesmos ids remotos abre o seu caso');
select is(
    (select count(distinct v.conexao_id)::int from public.chatwoot_conversations v where v.id_externo = '10'),
    2, 'uma conversa por instalação');
select is(
    (select count(*)::int from public.sac_cases s
       join public.chatwoot_conversations v on v.id_local = s.conversa_id_local and v.organizacao_id = s.organizacao_id
      where v.conexao_id = 'e6000000-0000-4000-8000-0000000000c2'),
    1, 'o caso de B fica na conversa de B');
select throws_ok(
    $$insert into public.sac_cases (organizacao_id, conversa_id_local)
      select 'e6000000-0000-4000-8000-00000000000b', v.id_local from public.chatwoot_conversations v
       where v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1' limit 1$$,
    '23503', null, 'FK composta: caso de B não aponta conversa de A');
-- O comando não carrega autoridade: chave extra é ignorada, e a organização vem da linha.
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000b', 'e6000000-0000-4000-8000-0000000000c2', 'v2:message_created:msg:104',
        pg_temp.msg(104, 10) || '{"organizacao_id":"e6000000-0000-4000-8000-00000000000a","conexao_id":"e6000000-0000-4000-8000-0000000000c1"}'::jsonb),
    'mensagem_no_caso', 'comando adulterado com outra organização: ignorado');
select is(
    (select m.organizacao_id from public.chatwoot_messages m where m.id_externo = '104'),
    'e6000000-0000-4000-8000-00000000000b'::uuid, 'a mensagem ficou na organização do evento');

-- ---------------------------------------------------------------------------
-- Disposição explícita.
-- ---------------------------------------------------------------------------
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:conversation_created:1',
        '{"evento":"conversation_created","acao":"ignorar"}'::jsonb),
    'evento_desconhecido', 'evento desconhecido recebe disposição');
select is(
    (select row(status, processed_at is not null)::text from public.inbox_eventos_chatwoot where idempotency_key = 'v2:conversation_created:1'),
    '(ignored,t)', 'e termina ignored');

-- Status: não cria conversa, não adota legada, respeita a revisão.
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 's:1',
        '{"evento":"conversation_status_changed","acao":"status","conversa":{"id":999,"status":"resolved"}}'::jsonb),
    'conversa_nao_espelhada', 'status de conversa desconhecida não cria nada');
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 's:2',
        '{"evento":"conversation_status_changed","acao":"status","revisao_status_em":"2030-01-01T00:00:02Z","conversa":{"id":10,"status":"resolved"}}'::jsonb),
    'espelho_atualizado', 'status mais novo aplica');
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 's:3',
        '{"evento":"conversation_status_changed","acao":"status","revisao_status_em":"2030-01-01T00:00:01Z","conversa":{"id":10,"status":"open"}}'::jsonb),
    'revisao_atrasada', 'status atrasado não sobrescreve');
select is(
    (select v.status from public.chatwoot_conversations v where v.id_externo = '10' and v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1'),
    'resolved', 'fica o status mais novo');

-- Status de B não toca a conversa de mesmo id em A.
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000b', 'e6000000-0000-4000-8000-0000000000c2', 's:b',
        '{"evento":"conversation_status_changed","acao":"status","revisao_status_em":"2031-01-01T00:00:00Z","conversa":{"id":10,"status":"pending"}}'::jsonb),
    'espelho_atualizado', 'status de B aplica em B');
select is(
    (select v.status from public.chatwoot_conversations v where v.id_externo = '10' and v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1'),
    'resolved', 'e a conversa de mesmo id em A fica como estava');

-- Conversa legada sem conexão provada: o status não prova a instalação.
alter table public.chatwoot_conversations disable trigger user;
update public.chatwoot_conversations set conexao_id = null, id = 11, id_externo = '11', status = 'open'
 where id_externo = '10' and conexao_id = 'e6000000-0000-4000-8000-0000000000c2';
alter table public.chatwoot_conversations enable trigger user;
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000b', 'e6000000-0000-4000-8000-0000000000c2', 's:legada',
        '{"evento":"conversation_status_changed","acao":"status","conversa":{"id":11,"status":"resolved"}}'::jsonb),
    'conexao_nao_comprovada', 'status em conversa legada recebe disposição própria');
select is(
    (select row(v.status, v.conexao_id)::text from public.chatwoot_conversations v
      where v.id_externo = '11' and v.organizacao_id = 'e6000000-0000-4000-8000-00000000000b'),
    '(open,)', 'e a conversa legada não muda nem é adotada');

-- Edição fora de ordem e criação atrasada.
select pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'u:2',
    pg_temp.msg(200, 20, 6, false, 'message_updated', 'sobrescrever', 'r2', '2030-01-01T00:00:02Z'));
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'u:1',
        pg_temp.msg(200, 20, 6, false, 'message_updated', 'sobrescrever', 'r1', '2030-01-01T00:00:01Z')),
    'revisao_atrasada', 'edição atrasada não sobrescreve');
select is(pg_temp.consumir('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:200', pg_temp.msg(200, 20, 6)),
    'caso_aberto', 'criação atrasada ainda abre o caso');
select is((select m.content from public.chatwoot_messages m where m.id_externo = '200'), 'r2', 'e não apaga a edição');

-- ---------------------------------------------------------------------------
-- Falha: nada parcial, retentativa e fim explícito.
-- ---------------------------------------------------------------------------
insert into t_ctx values ('e2', pg_temp.aceitar('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:300')::text);
insert into t_ctx values ('t3', pg_temp.token((select valor::uuid from t_ctx where nome = 'e2'), 'w4')::text);
-- Falha depois de gravar contato e conversa: abre_caso sem mensagem aborta no fim.
select throws_ok(
    format($$select * from public.aplicar_evento_inbox_chatwoot(%L, 'w4', %s,
        '{"evento":"message_created","acao":"espelhar","abre_caso":true,
          "contato":{"id":77,"nome":"Parcial"},"conversa":{"id":70,"contato_id":77,"inbox_id":1}}'::jsonb)$$,
        (select valor from t_ctx where nome = 'e2'), (select valor from t_ctx where nome = 't3')),
    '22023', null, 'falha no fim da transação');
select is((select count(*)::int from public.chatwoot_contacts where id_externo = '77'), 0, 'o contato gravado antes da falha não fica');
select is((select count(*)::int from public.chatwoot_conversations where id_externo = '70'), 0, 'nem a conversa');

select is(public.registrar_falha_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e2'), 'w4', (select valor::bigint from t_ctx where nome = 't3'), 'falha_22023', false),
    'nova_tentativa', 'falha repetível');
select is(pg_temp.token((select valor::uuid from t_ctx where nome = 'e2'), 'w5'), null, 'backoff: ainda não elegível');
select throws_ok(
    $$select public.registrar_falha_evento_inbox_chatwoot('e6000000-0000-4000-8000-0000000000e9', 'w', 1, 'telefone +5511999990001', false)$$,
    '22023', null, 'código de falha não aceita texto livre');

-- Tentativas esgotadas não voltam ao ciclo.
update public.inbox_eventos_chatwoot set attempts = 8, available_at = clock_timestamp() - interval '1 second'
 where id = (select valor::uuid from t_ctx where nome = 'e2');
select is(pg_temp.token((select valor::uuid from t_ctx where nome = 'e2'), 'w5'), null, 'tentativas esgotadas: fim');
select is(
    (select row(status, disposicao, last_error)::text from public.inbox_eventos_chatwoot where id = (select valor::uuid from t_ctx where nome = 'e2')),
    '(failed,falha_definitiva,tentativas_esgotadas)', 'falha definitiva explícita');
select is((select count(*)::int from public.eventos_auditoria_sistema a where a.acao = 'chatwoot.inbox_event_failed' and a.recurso_id = (select valor from t_ctx where nome = 'e2')), 1, 'e auditada');

-- Conexão desligada: não consome, e devolve sem gastar tentativa.
insert into t_ctx values ('e3', pg_temp.aceitar('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:400')::text);
insert into t_ctx values ('t4', pg_temp.token((select valor::uuid from t_ctx where nome = 'e3'), 'w6')::text);
update public.conexoes_integracao set status = 'desconectado' where id = 'e6000000-0000-4000-8000-0000000000c1';
select is(
    (select desfecho from public.aplicar_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e3'), 'w6', (select valor::bigint from t_ctx where nome = 't4'), pg_temp.msg(400, 40, 8))),
    'conexao_desligada', 'conexão desligada durante a lease: devolve');
select is(
    (select row(status, attempts, lease_owner)::text from public.inbox_eventos_chatwoot where id = (select valor::uuid from t_ctx where nome = 'e3')),
    '(received,0,)', 'de volta a received, sem gastar tentativa');
select is(pg_temp.token((select valor::uuid from t_ctx where nome = 'e3'), 'w7'), null, 'desligada: o claim não pega');
update public.conexoes_integracao set status = 'conectado' where id = 'e6000000-0000-4000-8000-0000000000c1';
select ok(pg_temp.token((select valor::uuid from t_ctx where nome = 'e3'), 'w7') is not null, 'religada: volta a ser consumida');

-- `processed` e `ignored` são terminais, e a função legada não atropela a lease.
select public.concluir_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e3'), 'failed', null, 'legado');
select is(
    (select status from public.inbox_eventos_chatwoot where id = (select valor::uuid from t_ctx where nome = 'e3')),
    'processing', 'função legada não mexe em evento sob lease');
select throws_ok(
    format($$update public.inbox_eventos_chatwoot set status = 'received' where id = %L$$, (select valor from t_ctx where nome = 'e1')),
    '55000', null, 'evento concluído não muda de estado, nem para o service_role');

-- Classificação: o banco é a última guarda da regra.
insert into t_ctx values ('e4', pg_temp.aceitar('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:500')::text);
insert into t_ctx values ('t5', pg_temp.token((select valor::uuid from t_ctx where nome = 'e4'), 'w8')::text);
select throws_ok(
    format($$select * from public.aplicar_evento_inbox_chatwoot(%L, 'w8', %s, %L::jsonb)$$,
        (select valor from t_ctx where nome = 'e4'), (select valor from t_ctx where nome = 't5'),
        (pg_temp.msg(500, 50, 9) #- '{mensagem,remetente_tipo}')::text),
    '22023', null, 'abrir caso sem remetente provado é recusado pelo banco');
select throws_ok(
    format($$select * from public.aplicar_evento_inbox_chatwoot(%L, 'w8', %s, %L::jsonb)$$,
        (select valor from t_ctx where nome = 'e4'), (select valor from t_ctx where nome = 't5'),
        pg_temp.msg(500, 50, 9, true, p_tipo => 'outgoing')::text),
    '22023', null, 'abrir caso com mensagem de saída é recusado pelo banco');
select is((select count(*)::int from public.chatwoot_messages where id_externo = '500'), 0, 'a recusa não deixou espelho');
select is(
    (select a.disposicao from public.aplicar_evento_inbox_chatwoot((select valor::uuid from t_ctx where nome = 'e4'), 'w8', (select valor::bigint from t_ctx where nome = 't5'),
        (pg_temp.msg(500, 50, 9, false) - 'mensagem') || '{"classificacao_inconclusiva":true}'::jsonb) a),
    'classificacao_inconclusiva', 'sem prova: não abre caso e diz por quê');
select is(
    (select count(*)::int from public.sac_cases s
       join public.chatwoot_conversations v on v.id_local = s.conversa_id_local and v.organizacao_id = s.organizacao_id
      where v.id_externo = '50' and v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1'),
    0, 'nenhum caso nasce da mensagem sem prova');

-- Revisão: o gatilho vale para qualquer gravador.
update public.chatwoot_conversations v set status = 'open', status_revisao_em = null
 where v.id_externo = '10' and v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1';
select is(
    (select v.status from public.chatwoot_conversations v where v.id_externo = '10' and v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1'),
    'resolved', 'escrita sem versão não muda status comprovado');
select is(
    (select to_char(v.status_revisao_em at time zone 'utc', 'YYYY') from public.chatwoot_conversations v
      where v.id_externo = '10' and v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1'),
    '2030', 'e a versão comprovada não se perde');
update public.chatwoot_conversations v set status = 'open', status_revisao_em = '2029-01-01T00:00:00Z'
 where v.id_externo = '10' and v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1';
select is(
    (select v.status from public.chatwoot_conversations v where v.id_externo = '10' and v.conexao_id = 'e6000000-0000-4000-8000-0000000000c1'),
    'resolved', 'escrita com versão mais velha também não');
update public.chatwoot_messages m set content = 'sem versao', message_type = 'outgoing', conteudo_revisao_em = null where m.id_externo = '200';
select is(
    (select row(m.content, m.message_type)::text from public.chatwoot_messages m where m.id_externo = '200'),
    '(r2,incoming)', 'conteúdo e tipo comprovados não mudam sem versão');
update public.chatwoot_messages m set content = 'anonimizado' where m.id_externo = '200';
select is((select m.content from public.chatwoot_messages m where m.id_externo = '200'), 'anonimizado',
    'quem não declara escrita versionada (retenção) continua apagando conteúdo');

-- Backlog: evento anterior ao corte não é reivindicado nem alterado.
insert into t_ctx values ('e5', pg_temp.aceitar('e6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-0000000000c1', 'v2:message_created:msg:600')::text);
select is(
    (select count(*)::int from public.reivindicar_eventos_inbox_chatwoot('w9', 50, 60, clock_timestamp() + interval '1 hour')),
    0, 'corte depois do evento: nada reivindicado');
select is(
    (select row(status, attempts)::text from public.inbox_eventos_chatwoot where id = (select valor::uuid from t_ctx where nome = 'e5')),
    '(received,0)', 'o evento antigo fica como estava');
select throws_ok(
    $$select * from public.reivindicar_eventos_inbox_chatwoot('w9', 50, 60, null)$$,
    '22023', null, 'sem corte, o claim recusa');

-- Papel mínimo: executa o consumo e nada mais.
select ok(
    (select not rolcanlogin and not rolsuper and not rolbypassrls from pg_roles where rolname = 'orbita_worker_inbox'),
    'orbita_worker_inbox sem login e sem ignorar RLS');
select is(
    (select count(*)::int
       from (values ('public.inbox_eventos_chatwoot'), ('public.sac_cases'), ('public.chatwoot_messages'), ('public.chatwoot_conversations'),
                    ('public.chatwoot_contacts'), ('public.credenciais_integracao'), ('public.eventos_auditoria_sistema')) as t(tabela)
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilegio)
      where has_table_privilege('orbita_worker_inbox', t.tabela, p.privilegio)),
    0, 'o papel não alcança nenhuma tabela');
select ok(not has_function_privilege('orbita_worker_inbox', 'public.concluir_evento_inbox_chatwoot(uuid,text,jsonb,text)', 'execute')
      and not has_function_privilege('orbita_worker_inbox', 'public.registrar_evento_auditoria(uuid,uuid,text,text,text,text,text,text,jsonb)', 'execute')
      and not has_function_privilege('orbita_worker_inbox', 'public.auditar_consumo_inbox_chatwoot(uuid,text,text,text,text,jsonb)', 'execute'),
    'nem as demais funções');
-- Com o papel, sem JWT de service_role: consome e audita. O grant vale só nesta transação.
grant orbita_worker_inbox to postgres;
select set_config('orbita.m6_comando', pg_temp.msg(600, 60, 12)::text, true);
set local request.jwt.claim.role = '';
set local role orbita_worker_inbox;
select set_config('orbita.m6_claim', (select r.evento_id::text || '|' || r.fencing_token::text
    from public.reivindicar_eventos_inbox_chatwoot('w-papel', 50, 60, 'epoch'::timestamptz) r limit 1), true);
select set_config('orbita.m6_disposicao', (select a.disposicao from public.aplicar_evento_inbox_chatwoot(
    split_part(current_setting('orbita.m6_claim'), '|', 1)::uuid, 'w-papel', split_part(current_setting('orbita.m6_claim'), '|', 2)::bigint,
    current_setting('orbita.m6_comando')::jsonb) a), true);
reset role;
set local request.jwt.claim.role = 'service_role';
select is(current_setting('orbita.m6_disposicao'), 'caso_aberto', 'com o papel, claim e aplicação funcionam');
select is(
    (select count(*)::int from public.eventos_auditoria_sistema a
      where a.acao = 'sac.case_opened' and a.metadata ->> 'evento_id' = (select valor from t_ctx where nome = 'e5')),
    1, 'e a auditoria fica na mesma transação, sem depender do JWT');

-- Retenção: apagar a conversa leva o caso, e a inbox fica sem o vínculo.
delete from public.chatwoot_conversations where id_externo = '20' and organizacao_id = 'e6000000-0000-4000-8000-00000000000a';
select is(
    (select count(*)::int from public.inbox_eventos_chatwoot e
      where e.idempotency_key = 'v2:message_created:msg:200' and e.caso_id is null and e.status = 'processed'),
    1, 'conversa eliminada: o caso cai em cascata e a inbox perde só o vínculo');

select * from finish();
rollback;
