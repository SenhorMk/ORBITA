-- vinculo_cliente_conversa.test.sql
-- MSG-010, contra o schema canônico completo: telefone igual é só candidato;
-- pedido só aparece depois que um atendente confirma o cliente; a consulta
-- fica presa a esse cliente e não distingue pedido alheio de inexistente;
-- números errados seguidos bloqueiam a consulta por número; a prova expira,
-- pode ser substituída ou desfeita, e não muda. A corrida entre confirmações
-- está em scripts/database-concurrency-vinculo-cliente.mjs.

begin;

select plan(70);

set local request.jwt.claim.role = 'service_role';

insert into auth.users (id, email) values
    ('ea000000-0000-4000-8000-0000000000a1', 'atendente-a-m10@orbita.test'),
    ('ea000000-0000-4000-8000-0000000000a0', 'dona-a-m10@orbita.test'),
    ('ea000000-0000-4000-8000-0000000000b1', 'dona-b-m10@orbita.test'),
    ('ea000000-0000-4000-8000-0000000000f1', 'fora-m10@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('ea000000-0000-4000-8000-00000000000a', 'Org A M10', 'org-a-m10', 'active'),
    ('ea000000-0000-4000-8000-00000000000b', 'Org B M10', 'org-b-m10', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', 'member'),
    ('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0', 'owner'),
    ('ea000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('ea000000-0000-4000-8000-0000000000c1', 'ea000000-0000-4000-8000-00000000000a', 'chatwoot', 'A1', 'conectado'),
    ('ea000000-0000-4000-8000-0000000000d1', 'ea000000-0000-4000-8000-00000000000b', 'chatwoot', 'B1', 'conectado');

-- Ana: única com o telefone do contato 5. Bia e Caio dividem o telefone do
-- contato 6. Eva foi anonimizada. Fábio não tem telefone. Dora é da Org B e
-- tem o mesmo telefone de Ana.
insert into public.clientes (id, organizacao_id, user_id, bling_id, nome, cpf_cnpj, telefone_normalizado, anonimizado_em) values
    ('ea000000-0000-4000-8000-0000000001a1', 'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0',
     'm10-ana', 'Ana Sintética', '123.456.789-09', '+5548900001001', null),
    ('ea000000-0000-4000-8000-0000000001a2', 'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0',
     'm10-bia', 'Bia Sintética', null, '+5548900001002', null),
    ('ea000000-0000-4000-8000-0000000001a3', 'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0',
     'm10-caio', 'Caio Sintético', null, '+5548900001002', null),
    ('ea000000-0000-4000-8000-0000000001a4', 'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0',
     'm10-eva', 'Eva Sintética', null, '+5548900001001', now()),
    ('ea000000-0000-4000-8000-0000000001a5', 'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0',
     'm10-fabio', 'Fábio Sintético', null, null, null),
    ('ea000000-0000-4000-8000-0000000001b1', 'ea000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-0000000000b1',
     'm10-dora', 'Dora Sintética', null, '+5548900001001', null);
insert into public.pedidos (id, organizacao_id, user_id, cliente_id, bling_id, numero, data, total, status, origem) values
    ('ea000000-0000-4000-8000-000000001001', 'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0',
     'ea000000-0000-4000-8000-0000000001a1', 'm10-1001', '1001', now() - interval '2 days', 10, 'Pendente', 'Bling'),
    ('ea000000-0000-4000-8000-000000001002', 'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0',
     'ea000000-0000-4000-8000-0000000001a1', 'm10-1002', '1002', now() - interval '1 day', 20, 'Atendido', 'Bling'),
    ('ea000000-0000-4000-8000-000000002001', 'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0',
     'ea000000-0000-4000-8000-0000000001a5', 'm10-2001', '2001', now(), 30, 'Pendente', 'Bling'),
    ('ea000000-0000-4000-8000-00000000b001', 'ea000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-0000000000b1',
     'ea000000-0000-4000-8000-0000000001b1', 'm10-b-1001', '1001', now(), 40, 'Pendente', 'Bling'),
    ('ea000000-0000-4000-8000-00000000b002', 'ea000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-0000000000b1',
     'ea000000-0000-4000-8000-0000000001b1', 'm10-b-3001', '3001', now() - interval '1 hour', 50, 'Pendente', 'Bling');

create temp table t_ctx (nome text primary key, valor uuid) on commit drop;

create function pg_temp.inbox(p_org uuid, p_conexao uuid, p_chave text, p_msg int, p_conv int, p_contato int, p_telefone text)
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
            'contato', jsonb_build_object('id', p_contato, 'nome', 'Contato', 'telefone', p_telefone, 'telefone_normalizado', p_telefone),
            'conversa', jsonb_build_object('id', p_conv, 'contato_id', p_contato, 'status', 'open', 'inbox_id', 1, 'canal', 'Channel::Api'),
            'mensagem', jsonb_build_object('id', p_msg, 'conversa_id', p_conv, 'conteudo', 'texto', 'tipo', 'incoming',
                                           'remetente_tipo', 'contact', 'modo', 'preservar'))) a);
end;
$$;

create function pg_temp.conversa(p_conexao uuid, p_conv int)
returns uuid language sql as $$
    select id_local from public.chatwoot_conversations where conexao_id = p_conexao and id_externo = p_conv::text;
$$;

create function pg_temp.c(p_nome text)
returns uuid language sql as $$ select valor from t_ctx where nome = p_nome; $$;

create function pg_temp.ler(p_org uuid, p_conversa uuid)
returns text language sql as $$
    select resultado || ':' || coalesce(estado, '-') || ':' || coalesce(cliente_nome, '-') || ':' || coalesce(candidatos::text, '-')
           || ':' || coalesce(consulta_bloqueada::text, '-')
      from public.ler_verificacao_cliente_sac(p_org, p_conversa);
$$;

create function pg_temp.confirmar(p_org uuid, p_ator uuid, p_conversa uuid, p_comando uuid, p_cliente uuid)
returns text language sql as $$
    select resultado from public.confirmar_vinculo_cliente_sac(p_org, p_ator, p_conversa, p_comando, p_cliente);
$$;

create function pg_temp.consultar(p_org uuid, p_conversa uuid, p_numero text default null)
returns text language sql as $$
    select string_agg(r.resultado || ':' || coalesce(r.numero, '-') || ':' || coalesce(r.pedido_id::text, '-'), ',' order by r.ord)
      from public.consultar_pedidos_do_cliente_verificado_sac(p_org, p_conversa, p_numero) with ordinality
           as r(resultado, pedido_id, numero, data, status, total, ord);
$$;

create function pg_temp.recusas(p_conversa uuid)
returns int language sql as $$
    select count(*)::int from public.sac_consultas_recusadas where conversa_id_local = p_conversa;
$$;

select pg_temp.inbox('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000c1', 'm10-a-1', 9201, 70, 5, '+5548900001001');
select pg_temp.inbox('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000c1', 'm10-a-2', 9202, 71, 6, '+5548900001002');
select pg_temp.inbox('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000c1', 'm10-a-3', 9203, 72, 7, null);
select pg_temp.inbox('ea000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-0000000000d1', 'm10-b-1', 9201, 70, 5, '+5548900001001');
insert into t_ctx values
    ('a70', pg_temp.conversa('ea000000-0000-4000-8000-0000000000c1', 70)),
    ('a71', pg_temp.conversa('ea000000-0000-4000-8000-0000000000c1', 71)),
    ('a72', pg_temp.conversa('ea000000-0000-4000-8000-0000000000c1', 72)),
    ('b70', pg_temp.conversa('ea000000-0000-4000-8000-0000000000d1', 70));

-- ---------------------------------------------------------------------------
-- Superfície.
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.sac_vinculos_cliente'::regclass)
          and (select relrowsecurity from pg_class where oid = 'public.sac_consultas_recusadas'::regclass),
          '1. prova e recusas com RLS');
select ok(not has_table_privilege('authenticated', 'public.sac_vinculos_cliente', 'select')
          and not has_table_privilege('anon', 'public.sac_vinculos_cliente', 'select')
          and not has_table_privilege('authenticated', 'public.sac_consultas_recusadas', 'select'),
          '2. navegador não lê prova nem recusas');
select ok(not has_table_privilege('service_role', 'public.sac_vinculos_cliente', 'select')
          and not has_table_privilege('service_role', 'public.sac_vinculos_cliente', 'insert')
          and not has_table_privilege('service_role', 'public.sac_vinculos_cliente', 'update')
          and not has_table_privilege('service_role', 'public.sac_consultas_recusadas', 'insert')
          and not has_table_privilege('service_role', 'public.sac_consultas_recusadas', 'delete'),
          '3. o servidor só chega às tabelas pelas funções');
select ok(not has_function_privilege('authenticated', 'public.confirmar_vinculo_cliente_sac(uuid,uuid,uuid,uuid,uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.revogar_vinculo_cliente_sac(uuid,uuid,uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.consultar_pedidos_do_cliente_verificado_sac(uuid,uuid,text)', 'execute')
          and not has_function_privilege('anon', 'public.ler_verificacao_cliente_sac(uuid,uuid)', 'execute')
          and not has_function_privilege('anon', 'public.listar_candidatos_cliente_sac(uuid,uuid)', 'execute'),
          '4. navegador não confirma, não revoga e não consulta');
select ok(has_function_privilege('service_role', 'public.confirmar_vinculo_cliente_sac(uuid,uuid,uuid,uuid,uuid)', 'execute')
          and has_function_privilege('service_role', 'public.consultar_pedidos_do_cliente_verificado_sac(uuid,uuid,text)', 'execute')
          and not has_function_privilege('service_role', 'public.sac_vinculo_vigente(uuid,uuid)', 'execute')
          and not has_function_privilege('service_role', 'public.auditar_vinculo_cliente_sac(uuid,uuid,text,uuid,jsonb)', 'execute'),
          '5. servidor executa as funções públicas; auxiliares nem ele');
select ok((select count(*) = 3 from public.catalogo_eventos_auditoria
            where nome in ('sac.customer_verified', 'sac.customer_verification_revoked', 'sac.order_lookup_blocked')),
          '6. eventos novos no catálogo SQL');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'consultar_pedidos_do_cliente_verificado_sac'
              and ('cliente_id' = any (p.proargnames[1:p.pronargs]) or 'p_cliente_id' = any (p.proargnames[1:p.pronargs]))), 0,
          '7. a consulta não aceita cliente como parâmetro');

-- ---------------------------------------------------------------------------
-- Antes da prova: telefone igual é só candidato; nada é consultado.
-- ---------------------------------------------------------------------------
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')), 'encontrada:sem_prova:-:1:false',
          '8. um cliente com o telefone do contato não é prova');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a71')), 'encontrada:sem_prova:-:2:false',
          '9. telefone dividido por dois clientes: dois candidatos, sem prova');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a72')), 'encontrada:sem_prova:-:0:false',
          '10. contato sem telefone: nenhum candidato');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('b70')), 'conversa_inexistente:-:-:-:-',
          '11. conversa de outra organização: não encontrada');
select is((select string_agg(nome || ':' || coalesce(documento_final, '-'), ',' order by nome)
             from public.listar_candidatos_cliente_sac('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'))),
          'Ana Sintética:09', '12. candidato com os dois últimos dígitos do documento; a anonimizada e a de outra organização ficam fora');
select is((select count(*)::int from public.listar_candidatos_cliente_sac('ea000000-0000-4000-8000-00000000000a', pg_temp.c('b70'))), 0,
          '13. candidatos de conversa alheia: nenhuma linha');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')), 'sem_prova:-:-',
          '14. sem prova, a lista de pedidos não sai');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '1001'), 'sem_prova:-:-',
          '15. sem prova, número certo também não sai');
select is(pg_temp.recusas(pg_temp.c('a70')), 0, '16. consulta sem prova não é avaliada nem contada');

-- ---------------------------------------------------------------------------
-- Confirmar: só membro, só cliente da organização, uma vez por comando.
-- ---------------------------------------------------------------------------
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000f1', pg_temp.c('a70'),
                            'eb000000-0000-4000-8000-000000000001', 'ea000000-0000-4000-8000-0000000001a1'),
          'sem_vinculo', '17. pessoa de fora da organização não confirma');
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('b70'),
                            'eb000000-0000-4000-8000-000000000002', 'ea000000-0000-4000-8000-0000000001a1'),
          'conversa_inexistente', '18. conversa de outra organização não recebe vínculo');
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70'),
                            'eb000000-0000-4000-8000-000000000003', 'ea000000-0000-4000-8000-0000000001b1'),
          'cliente_inexistente', '19. cliente de outra organização: inexistente');
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70'),
                            'eb000000-0000-4000-8000-000000000004', 'ea000000-0000-4000-8000-0000000001a4'),
          'cliente_inexistente', '20. cliente anonimizado: a mesma resposta');
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70'),
                            'eb000000-0000-4000-8000-000000000005', 'ea000000-0000-4000-8000-0000000009ff'),
          'cliente_inexistente', '21. cliente que não existe: a mesma resposta');
select is((select count(*)::int from public.sac_vinculos_cliente), 0, '22. nenhuma recusa gravou prova');
select throws_ok($$ select * from public.confirmar_vinculo_cliente_sac(
                        'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', null,
                        'eb000000-0000-4000-8000-000000000006', 'ea000000-0000-4000-8000-0000000001a1') $$,
                 '22023', null, '23. comando sem conversa é inválido');

create temp table t_confirma on commit drop as
select * from public.confirmar_vinculo_cliente_sac(
    'ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70'),
    'eb000000-0000-4000-8000-000000000010', 'ea000000-0000-4000-8000-0000000001a1');

select is((select resultado from t_confirma), 'aplicado', '24. atendente confirma Ana na conversa');
select ok((select expira_em between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute' from t_confirma),
          '25. a prova vale 24 horas');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')), 'encontrada:verificado:Ana Sintética:1:false',
          '26. a conversa passa a verificada, com o nome do cliente');
select is((select v.caso_id from public.sac_vinculos_cliente v where v.id = (select vinculo_id from t_confirma)),
          (select s.id from public.sac_cases s where s.conversa_id_local = pg_temp.c('a70')),
          '27. a prova guarda o caso aberto');
select is((select count(*)::int from public.eventos_auditoria_sistema e
            where e.acao = 'sac.customer_verified' and e.recurso_id = (select vinculo_id::text from t_confirma)
              and e.actor_id = 'ea000000-0000-4000-8000-0000000000a1'
              and e.metadata ->> 'metodo' = 'humano' and (e.metadata ->> 'telefone_confere')::boolean
              and not (e.metadata ->> 'substituiu')::boolean), 1,
          '28. confirmação auditada com ator, método e conferência do telefone');
select ok((select e.metadata::text !~ '123|789|4890000' from public.eventos_auditoria_sistema e
            where e.acao = 'sac.customer_verified' and e.recurso_id = (select vinculo_id::text from t_confirma)),
          '29. a trilha não leva documento nem telefone');
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70'),
                            'eb000000-0000-4000-8000-000000000010', 'ea000000-0000-4000-8000-0000000001a1'),
          'existente', '30. o mesmo comando de novo: existente');
select is((select count(*)::int from public.sac_vinculos_cliente where conversa_id_local = pg_temp.c('a70')), 1,
          '31. a repetição não grava outra prova');
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70'),
                            'eb000000-0000-4000-8000-000000000010', 'ea000000-0000-4000-8000-0000000001a5'),
          'conflito_comando', '32. o mesmo comando com outro cliente: conflito');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')), 'encontrada:verificado:Ana Sintética:1:false',
          '33. conflito não troca o cliente');

-- ---------------------------------------------------------------------------
-- Consulta: só os pedidos do cliente confirmado.
-- ---------------------------------------------------------------------------
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')),
          'pedido:1002:ea000000-0000-4000-8000-000000001002,pedido:1001:ea000000-0000-4000-8000-000000001001',
          '34. lista só os pedidos de Ana, do mais recente ao mais antigo');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '1001'),
          'pedido:1001:ea000000-0000-4000-8000-000000001001',
          '35. número de Ana: o pedido dela, não o de mesmo número da outra organização');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '2001'), 'nao_encontrado:-:-',
          '36. pedido de outro cliente da mesma organização: não encontrado');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '3001'), 'nao_encontrado:-:-',
          '37. pedido de outra organização: a mesma resposta');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '9999'), 'nao_encontrado:-:-',
          '38. pedido que não existe: a mesma resposta');
select is(pg_temp.recusas(pg_temp.c('a70')), 3, '39. cada número sem resultado foi contado; o acerto não');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000b', pg_temp.c('a70')), 'conversa_inexistente:-:-',
          '40. outra organização não consulta a conversa');
select throws_ok($$ select * from public.consultar_pedidos_do_cliente_verificado_sac(
                        'ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), ' 1001 ') $$,
                 '22023', null, '41. número com espaço em volta é inválido');
select throws_ok($$ select * from public.consultar_pedidos_do_cliente_verificado_sac(
                        'ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), repeat('9', 41)) $$,
                 '22023', null, '42. número longo demais é inválido');

-- ---------------------------------------------------------------------------
-- Tentativas seguidas: a consulta por número para.
-- ---------------------------------------------------------------------------
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '9998'), 'nao_encontrado:-:-',
          '43. quarta tentativa sem resultado');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '9997'), 'nao_encontrado:-:-',
          '44. quinta tentativa sem resultado');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '1001'), 'bloqueada:-:-',
          '45. depois de cinco, nem o número certo é avaliado');
select is(pg_temp.recusas(pg_temp.c('a70')), 5, '46. consulta bloqueada não soma tentativa');
select is((select count(*)::int from public.eventos_auditoria_sistema e
            where e.acao = 'sac.order_lookup_blocked' and e.metadata ->> 'conversa_id_local' = pg_temp.c('a70')::text
              and e.actor_id is null), 1,
          '47. o bloqueio é auditado uma vez, sem o número tentado');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')), 'encontrada:verificado:Ana Sintética:1:true',
          '48. a leitura mostra a consulta bloqueada');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')),
          'pedido:1002:ea000000-0000-4000-8000-000000001002,pedido:1001:ea000000-0000-4000-8000-000000001001',
          '49. a lista dos pedidos do cliente continua disponível');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a71'), '1001'), 'sem_prova:-:-',
          '50. o bloqueio é da conversa: a outra segue na regra dela');
update public.sac_consultas_recusadas set created_at = now() - interval '16 minutes' where conversa_id_local = pg_temp.c('a70');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70'), '1001'),
          'pedido:1001:ea000000-0000-4000-8000-000000001001', '51. passada a janela de 15 minutos, a consulta por número volta');

-- ---------------------------------------------------------------------------
-- Telefone dividido: quem decide é o atendente; uma prova por conversa.
-- ---------------------------------------------------------------------------
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a71'),
                            'eb000000-0000-4000-8000-000000000020', 'ea000000-0000-4000-8000-0000000001a2'),
          'aplicado', '52. atendente escolhe Bia entre os dois candidatos');
select is(pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a0', pg_temp.c('a71'),
                            'eb000000-0000-4000-8000-000000000021', 'ea000000-0000-4000-8000-0000000001a3'),
          'aplicado', '53. outra pessoa corrige para Caio');
select is((select string_agg(c.nome || ':' || coalesce(v.revogacao_motivo, 'vigente'), ',' order by v.created_at, c.nome)
             from public.sac_vinculos_cliente v join public.clientes c on c.id = v.cliente_id
            where v.conversa_id_local = pg_temp.c('a71')),
          'Bia Sintética:substituido,Caio Sintético:vigente', '54. a prova anterior fica revogada como substituída');
select is((select (e.metadata ->> 'substituiu')::boolean from public.eventos_auditoria_sistema e
            where e.acao = 'sac.customer_verified' and e.actor_id = 'ea000000-0000-4000-8000-0000000000a0'
              and e.metadata ->> 'conversa_id_local' = pg_temp.c('a71')::text), true,
          '55. a substituição aparece na trilha');
select throws_ok($$ insert into public.sac_vinculos_cliente (organizacao_id, conversa_id_local, cliente_id, command_id, expira_em)
                    values ('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a71'), 'ea000000-0000-4000-8000-0000000001a2',
                            'eb000000-0000-4000-8000-000000000022', now() + interval '1 hour') $$,
                 '23505', null, '56. duas provas vigentes na mesma conversa: o banco recusa');
select throws_ok($$ insert into public.sac_vinculos_cliente (organizacao_id, conversa_id_local, cliente_id, command_id, expira_em)
                    values ('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a72'), 'ea000000-0000-4000-8000-0000000001b1',
                            'eb000000-0000-4000-8000-000000000023', now() + interval '1 hour') $$,
                 '23503', null, '57. prova com cliente de outra organização: a FK composta recusa');

-- ---------------------------------------------------------------------------
-- A prova não muda e deixa de valer sozinha.
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.sac_vinculos_cliente set cliente_id = 'ea000000-0000-4000-8000-0000000001a5'
                     where conversa_id_local = pg_temp.c('a70') $$,
                 '23514', null, '58. o cliente da prova não é trocado');
select throws_ok($$ update public.sac_vinculos_cliente set expira_em = now() + interval '30 days'
                     where conversa_id_local = pg_temp.c('a70') $$,
                 '23514', null, '59. o prazo da prova não é esticado');
select throws_ok($$ update public.sac_vinculos_cliente set revogado_em = null, revogacao_motivo = null
                     where conversa_id_local = pg_temp.c('a71') and revogacao_motivo = 'substituido' $$,
                 '23514', null, '60. prova revogada não volta');

-- Prova vencida: nascida há 25 horas, vencida há uma.
insert into public.sac_vinculos_cliente (organizacao_id, conversa_id_local, cliente_id, command_id, created_at, expira_em)
values ('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a72'), 'ea000000-0000-4000-8000-0000000001a5',
        'eb000000-0000-4000-8000-000000000030', now() - interval '25 hours', now() - interval '1 hour');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a72')), 'encontrada:expirada:-:0:false',
          '61. prova vencida: a conversa volta a não verificada');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a72')), 'sem_prova:-:-',
          '62. prova vencida não libera pedido');

update public.clientes set anonimizado_em = now() where id = 'ea000000-0000-4000-8000-0000000001a3';
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a71')), 'sem_prova:-:-',
          '63. cliente anonimizado depois da prova: a consulta fecha');

-- ---------------------------------------------------------------------------
-- Desfazer e fechar o caso.
-- ---------------------------------------------------------------------------
select is(public.revogar_vinculo_cliente_sac('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000f1', pg_temp.c('a70')),
          'sem_vinculo', '64. pessoa de fora não desfaz');
select is(public.revogar_vinculo_cliente_sac('ea000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-0000000000b1', pg_temp.c('a70')),
          'conversa_inexistente', '65. outra organização não desfaz');
select is(public.revogar_vinculo_cliente_sac('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70')),
          'aplicado', '66. atendente desfaz a confirmação');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')) || '|'
          || pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')) || '|'
          || public.revogar_vinculo_cliente_sac('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70')),
          'encontrada:sem_prova:-:1:false|sem_prova:-:-|sem_prova', '67. desfeita: sem prova, sem pedidos, e desfazer de novo não tem efeito');
select is((select count(*)::int from public.eventos_auditoria_sistema e
            where e.acao = 'sac.customer_verification_revoked' and e.actor_id = 'ea000000-0000-4000-8000-0000000000a1'), 1,
          '68. a revogação é auditada uma vez');

select pg_temp.confirmar('ea000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-0000000000a1', pg_temp.c('a70'),
                         'eb000000-0000-4000-8000-000000000040', 'ea000000-0000-4000-8000-0000000001a1');
update public.sac_cases set phase = 'CLOSED' where conversa_id_local = pg_temp.c('a70');
select is(pg_temp.ler('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')) || '|'
          || pg_temp.consultar('ea000000-0000-4000-8000-00000000000a', pg_temp.c('a70')),
          'encontrada:expirada:-:1:false|sem_prova:-:-', '69. caso fechado: a prova dele deixa de valer');

-- ---------------------------------------------------------------------------
-- A outra organização tem a própria prova e os próprios pedidos.
-- ---------------------------------------------------------------------------
select pg_temp.confirmar('ea000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-0000000000b1', pg_temp.c('b70'),
                         'eb000000-0000-4000-8000-000000000050', 'ea000000-0000-4000-8000-0000000001b1');
select is(pg_temp.consultar('ea000000-0000-4000-8000-00000000000b', pg_temp.c('b70')),
          'pedido:1001:ea000000-0000-4000-8000-00000000b001,pedido:3001:ea000000-0000-4000-8000-00000000b002',
          '70. Org B vê só os pedidos de Dora, com o mesmo telefone e o mesmo número de pedido da Org A');

select * from finish();
rollback;
