-- retrato_do_pedido_sac.test.sql
-- MSG-011, contra o schema canônico completo: o retrato de um pedido só sai
-- para o cliente confirmado na conversa; pedido alheio, de outra organização
-- ou inexistente dão a mesma recusa; o estoque é o do produto da mesma
-- organização; só o título a receber conta como pagamento; a sincronização
-- aparece como foi gravada; a função não escreve nem expõe o cadastro.

begin;

select plan(30);

set local request.jwt.claim.role = 'service_role';

insert into auth.users (id, email) values
    ('eb000000-0000-4000-8000-0000000000a1', 'atendente-a-m11@orbita.test'),
    ('eb000000-0000-4000-8000-0000000000a0', 'dona-a-m11@orbita.test'),
    ('eb000000-0000-4000-8000-0000000000b1', 'dona-b-m11@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('eb000000-0000-4000-8000-00000000000a', 'Org A M11', 'org-a-m11', 'active'),
    ('eb000000-0000-4000-8000-00000000000b', 'Org B M11', 'org-b-m11', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a1', 'member'),
    ('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0', 'owner'),
    ('eb000000-0000-4000-8000-00000000000b', 'eb000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
    ('eb000000-0000-4000-8000-0000000000c1', 'eb000000-0000-4000-8000-00000000000a', 'chatwoot', 'A1', 'conectado'),
    ('eb000000-0000-4000-8000-0000000000d1', 'eb000000-0000-4000-8000-00000000000b', 'chatwoot', 'B1', 'conectado');

-- Ana é a cliente da conversa. Fábio é outro cliente da Org A. Dora é da Org B.
insert into public.clientes (id, organizacao_id, user_id, bling_id, nome, cpf_cnpj, telefone_normalizado, endereco) values
    ('eb000000-0000-4000-8000-0000000001a1', 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'm11-ana', 'Ana Sintética', '123.456.789-09', '+5548900002001', 'Rua Sintética, 11'),
    ('eb000000-0000-4000-8000-0000000001a5', 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'm11-fabio', 'Fábio Sintético', null, null, null),
    ('eb000000-0000-4000-8000-0000000001b1', 'eb000000-0000-4000-8000-00000000000b', 'eb000000-0000-4000-8000-0000000000b1',
     'm11-dora', 'Dora Sintética', null, '+5548900002001', null);

insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, codigo, preco, estoque) values
    ('eb000000-0000-4000-8000-0000000002a1', 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'm11-p1', 'Camiseta Sintética', 'CAM-11', 49.90, 10),
    ('eb000000-0000-4000-8000-0000000002a2', 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'm11-p2', 'Caneca Sintética', 'CAN-11', 30.00, 5),
    ('eb000000-0000-4000-8000-0000000002b1', 'eb000000-0000-4000-8000-00000000000b', 'eb000000-0000-4000-8000-0000000000b1',
     'm11-pb', 'Produto de B', 'B-11', 10.00, 5);
-- 55 produtos para o pedido grande (um item por produto).
insert into public.produtos (organizacao_id, user_id, bling_id, nome, preco, estoque)
select 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0', 'm11-g' || n, 'Granel ' || lpad(n::text, 2, '0'), 1, 100
  from generate_series(1, 55) n;

insert into public.pedidos (id, organizacao_id, user_id, cliente_id, bling_id, numero, data, total, frete, status, origem, forma_pagamento) values
    ('eb000000-0000-4000-8000-000000001001', 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'eb000000-0000-4000-8000-0000000001a1', 'm11-1001', '1001', now() - interval '2 days', 129.80, 0, 'Em Processamento', 'Bling', 'Pix'),
    ('eb000000-0000-4000-8000-000000001002', 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'eb000000-0000-4000-8000-0000000001a1', 'm11-1002', '1002', now() - interval '1 day', 55, 0, 'Em Processamento', 'Bling', 'Boleto'),
    ('eb000000-0000-4000-8000-000000002001', 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'eb000000-0000-4000-8000-0000000001a5', 'm11-2001', '2001', now(), 30, 0, 'Pendente', 'Bling', null),
    ('eb000000-0000-4000-8000-00000000b001', 'eb000000-0000-4000-8000-00000000000b', 'eb000000-0000-4000-8000-0000000000b1',
     'eb000000-0000-4000-8000-0000000001b1', 'm11-b-1001', '1001', now(), 10, 0, 'Pendente', 'Bling', null);

insert into public.itens_pedido (organizacao_id, user_id, pedido_id, produto_id, quantidade, valor_unitario) values
    ('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'eb000000-0000-4000-8000-000000001001', 'eb000000-0000-4000-8000-0000000002a1', 2, 49.90),
    ('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0',
     'eb000000-0000-4000-8000-000000001001', 'eb000000-0000-4000-8000-0000000002a2', 1, 30.00),
    ('eb000000-0000-4000-8000-00000000000b', 'eb000000-0000-4000-8000-0000000000b1',
     'eb000000-0000-4000-8000-00000000b001', 'eb000000-0000-4000-8000-0000000002b1', 1, 10.00);
insert into public.itens_pedido (organizacao_id, user_id, pedido_id, produto_id, quantidade, valor_unitario)
select 'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0', 'eb000000-0000-4000-8000-000000001002', p.id, 1, 1
  from public.produtos p where p.bling_id like 'm11-g%';

-- A caneca sai de linha depois da venda.
select public.arquivar_produto('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000002a2',
                               'eb000000-0000-4000-8000-0000000000a0');

-- O pedido 1001 tem um título a receber (pago) e uma conta a pagar ligada a ele.
insert into public.titulos_financeiros (organizacao_id, user_id, pedido_id, tipo, situacao, situacao_bling, valor, data_vencimento, data_pagamento, descricao) values
    ('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0', 'eb000000-0000-4000-8000-000000001001',
     'receber', 'pago', 2, 129.80, current_date - 2, current_date - 2, 'Venda 1001'),
    ('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0', 'eb000000-0000-4000-8000-000000001001',
     'pagar', 'aberto', null, 7.77, current_date + 10, null, 'Frete do fornecedor 1001');

insert into public.sync_state (organizacao_id, user_id, entidade, last_synced_at) values
    ('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0', 'pedidos', '2026-11-01T10:00:00Z'),
    ('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a0', 'produtos', '2026-11-01T10:00:05Z'),
    ('eb000000-0000-4000-8000-00000000000b', 'eb000000-0000-4000-8000-0000000000b1', 'pedidos', '2026-11-11T10:00:00Z');
insert into public.sync_jobs (organizacao_id, status, created_at, updated_at, completed_at) values
    ('eb000000-0000-4000-8000-00000000000a', 'completed', '2026-11-01T09:59:00Z', '2026-11-01T10:00:06Z', '2026-11-01T10:00:06Z'),
    ('eb000000-0000-4000-8000-00000000000a', 'failed', '2026-11-10T12:00:00Z', '2026-11-10T12:00:30Z', null),
    ('eb000000-0000-4000-8000-00000000000b', 'completed', '2026-11-11T09:59:00Z', '2026-11-11T10:00:00Z', '2026-11-11T10:00:00Z');

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

create function pg_temp.retrato(p_org uuid, p_conversa uuid, p_pedido uuid)
returns jsonb language sql as $$
    select public.retrato_do_pedido_verificado_sac(p_org, p_conversa, p_pedido);
$$;

create function pg_temp.item(p_retrato jsonb, p_nome text)
returns jsonb language sql as $$
    select i from jsonb_array_elements(p_retrato -> 'itens') i where i ->> 'nome' = p_nome;
$$;

select pg_temp.inbox('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000c1', 'm11-a-1', 9301, 80, 15, '+5548900002001');
select pg_temp.inbox('eb000000-0000-4000-8000-00000000000b', 'eb000000-0000-4000-8000-0000000000d1', 'm11-b-1', 9301, 80, 15, '+5548900002001');
insert into t_ctx values
    ('a80', pg_temp.conversa('eb000000-0000-4000-8000-0000000000c1', 80)),
    ('b80', pg_temp.conversa('eb000000-0000-4000-8000-0000000000d1', 80));

-- ---------------------------------------------------------------------------
-- Superfície.
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)', 'execute')
          and not has_function_privilege('anon', 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)', 'execute'),
          '1. navegador não lê o retrato');
select ok(has_function_privilege('service_role', 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)', 'execute'),
          '2. servidor lê o retrato');
select is((select provolatile::text from pg_proc where oid = 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)'::regprocedure), 's',
          '3. a função é stable: o Postgres recusa escrita dentro dela');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'retrato_do_pedido_verificado_sac'
              and 'p_cliente_id' = any (p.proargnames[1:p.pronargs])), 0,
          '4. o retrato não aceita cliente como parâmetro');
select throws_ok($$select public.retrato_do_pedido_verificado_sac(null, null, null)$$, '22023', null,
                 '5. parâmetros nulos: recusa explícita');

-- ---------------------------------------------------------------------------
-- Antes da prova: nada sai.
-- ---------------------------------------------------------------------------
select is(pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), 'eb000000-0000-4000-8000-000000001001'),
          '{"resultado": "sem_prova"}'::jsonb, '6. sem cliente confirmado: sem_prova');
select is(pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('b80'), 'eb000000-0000-4000-8000-000000001001'),
          '{"resultado": "conversa_inexistente"}'::jsonb, '7. conversa de outra organização: inexistente');

select is((select resultado from public.confirmar_vinculo_cliente_sac(
              'eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a1', pg_temp.c('a80'),
              'eb000000-0000-4000-8000-00000000c0f1', 'eb000000-0000-4000-8000-0000000001a1')), 'aplicado',
          '8. atendente confirma Ana na conversa');

-- ---------------------------------------------------------------------------
-- Com a prova: o retrato do pedido de Ana.
-- ---------------------------------------------------------------------------
create temp table t_retrato on commit drop as
    select pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), 'eb000000-0000-4000-8000-000000001001') r;

select is((select r ->> 'resultado' from t_retrato), 'retrato', '9. pedido de Ana: retrato');
select is((select r -> 'pedido' ->> 'numero' from t_retrato) || ':' || (select r -> 'pedido' ->> 'forma_pagamento' from t_retrato)
          || ':' || (select r -> 'pedido' ->> 'status' from t_retrato), '1001:Pix:Em Processamento',
          '10. cabeçalho do pedido');
select is((select (r ->> 'total_de_itens')::int || ':' || jsonb_array_length(r -> 'itens') from t_retrato), '2:2',
          '11. dois itens, os dois devolvidos');
select is((select (pg_temp.item(r, 'Camiseta Sintética') ->> 'estoque')::int - (pg_temp.item(r, 'Camiseta Sintética') ->> 'estoque_reservado')::int
             from t_retrato),
          (select estoque - estoque_reservado from public.produtos where id = 'eb000000-0000-4000-8000-0000000002a1'),
          '12. estoque e reserva do produto, como estão na tabela');
select ok((select (pg_temp.item(r, 'Camiseta Sintética') ->> 'estoque_reservado')::int >= 2 from t_retrato),
          '13. a reserva do pedido aberto aparece');
select is((select pg_temp.item(r, 'Caneca Sintética') ->> 'produto_situacao' from t_retrato), 'arquivado',
          '14. produto arquivado depois da venda: situação arquivado, item preservado');
select is((select pg_temp.item(r, 'Caneca Sintética') ->> 'nome' from t_retrato), 'Caneca Sintética',
          '15. o nome vem do retrato do item');
select is((select r -> 'titulo' ->> 'situacao' || ':' || (r -> 'titulo' ->> 'situacao_bling') || ':' || (r -> 'titulo' ->> 'valor') from t_retrato),
          'pago:2:129.80', '16. o título a receber do pedido');
select ok((select (r -> 'titulo') ->> 'valor' <> '7.77' from t_retrato),
          '17. a conta a pagar ligada ao pedido não é pagamento do cliente');
select is((select r -> 'sincronizacao' ->> 'pedidos' from t_retrato)::timestamptz, '2026-11-01T10:00:00Z'::timestamptz,
          '18. quando os pedidos foram sincronizados');
select is((select r -> 'sincronizacao' -> 'ultimo_job' ->> 'status' from t_retrato), 'failed',
          '19. a última sincronização terminada falhou, e o retrato diz');
select ok((select r -> 'sincronizacao' -> 'financeiro' = 'null'::jsonb from t_retrato),
          '20. financeiro nunca sincronizado: nulo, não inventado');
select ok((select r::text !~ '(123\.456|cpf|telefone|endereco|Rua Sint|5548900002001|bling_id)' from t_retrato),
          '21. nada do cadastro do cliente nem id do Bling no retrato');

-- ---------------------------------------------------------------------------
-- Escopo: o mesmo "não encontrado" para tudo que não é dela.
-- ---------------------------------------------------------------------------
select is(pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), 'eb000000-0000-4000-8000-000000002001'),
          '{"resultado": "nao_encontrado"}'::jsonb, '22. pedido de outro cliente: não encontrado');
select is(pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), 'eb000000-0000-4000-8000-00000000b001'),
          '{"resultado": "nao_encontrado"}'::jsonb, '23. pedido de outra organização: não encontrado');
select is(pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), 'eb000000-0000-4000-8000-00000000dead'),
          '{"resultado": "nao_encontrado"}'::jsonb, '24. pedido inexistente: não encontrado');
select is(pg_temp.retrato('eb000000-0000-4000-8000-00000000000b', pg_temp.c('a80'), 'eb000000-0000-4000-8000-000000001001'),
          '{"resultado": "conversa_inexistente"}'::jsonb, '25. Org B pedindo pela conversa da Org A: inexistente');

-- ---------------------------------------------------------------------------
-- Cardinalidade e ausência de escrita.
-- ---------------------------------------------------------------------------
select is((select (r ->> 'total_de_itens')::int || ':' || jsonb_array_length(r -> 'itens')
             from (select pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), 'eb000000-0000-4000-8000-000000001002') r) x),
          '55:50', '26. pedido com 55 itens: devolve 50 e conta os 55');
select ok((select r -> 'titulo' = 'null'::jsonb
             from (select pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), 'eb000000-0000-4000-8000-000000001002') r) x),
          '27. pedido sem título a receber: título nulo, nunca pago');
create function pg_temp.estado()
returns text language sql as $$
    select (select md5(string_agg(t::text, ',' order by t.id)) from public.produtos t
             where t.organizacao_id = 'eb000000-0000-4000-8000-00000000000a')
        || (select md5(string_agg(t::text, ',' order by t.entidade)) from public.sync_state t
             where t.organizacao_id = 'eb000000-0000-4000-8000-00000000000a')
        || (select count(*)::text from public.sync_jobs)
        || (select count(*)::text from public.sac_consultas_recusadas);
$$;
create temp table t_estado on commit drop as select pg_temp.estado() antes;
select pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), id)
  from (values ('eb000000-0000-4000-8000-000000001001'::uuid), ('eb000000-0000-4000-8000-00000000dead'::uuid),
               ('eb000000-0000-4000-8000-000000002001'::uuid)) v(id);
select is(pg_temp.estado(), (select antes from t_estado),
          '28. consultar (inclusive pedido inexistente e alheio) não muda produtos, sincronização nem recusas');

-- ---------------------------------------------------------------------------
-- A prova desfeita fecha o retrato.
-- ---------------------------------------------------------------------------
select is((select public.revogar_vinculo_cliente_sac('eb000000-0000-4000-8000-00000000000a', 'eb000000-0000-4000-8000-0000000000a1', pg_temp.c('a80'))),
          'aplicado', '29. atendente desfaz a confirmação');
select is(pg_temp.retrato('eb000000-0000-4000-8000-00000000000a', pg_temp.c('a80'), 'eb000000-0000-4000-8000-000000001001'),
          '{"resultado": "sem_prova"}'::jsonb, '30. sem prova vigente, o retrato fecha de novo');

select * from finish();
rollback;
