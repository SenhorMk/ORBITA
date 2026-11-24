begin;
set local request.jwt.claim.role='service_role';
select plan(26);
insert into auth.users(id,email) values
 ('a1040000-0000-4000-8000-000000000001','admin104@orbita.test'),
 ('a1040000-0000-4000-8000-000000000002','outro104@orbita.test'),
 ('a1040000-0000-4000-8000-000000000003','membro104@orbita.test'),
 ('a1040000-0000-4000-8000-000000000004','empresa104@orbita.test');
insert into public.organizacoes(id,nome,slug,status) values
 ('b1040000-0000-4000-8000-000000000001','A104','a104','active'),
 ('b1040000-0000-4000-8000-000000000002','B104','b104','active');
insert into public.membros_organizacao(organizacao_id,user_id,papel) values
 ('b1040000-0000-4000-8000-000000000001','a1040000-0000-4000-8000-000000000001','owner'),
 ('b1040000-0000-4000-8000-000000000001','a1040000-0000-4000-8000-000000000002','admin'),
 ('b1040000-0000-4000-8000-000000000001','a1040000-0000-4000-8000-000000000003','member'),
 ('b1040000-0000-4000-8000-000000000002','a1040000-0000-4000-8000-000000000004','owner');
insert into public.produtos(id,user_id,organizacao_id,bling_id,nome,preco,estoque,situacao) values
 ('c1040000-0000-4000-8000-000000000001','a1040000-0000-4000-8000-000000000001',
  'b1040000-0000-4000-8000-000000000001','123','Rapé A',20,12,'ativo');

create function pg_temp.conteudo() returns jsonb language sql as $$
 select jsonb_build_object('itens',jsonb_build_array(jsonb_build_object(
  'produtoId','c1040000-0000-4000-8000-000000000001','blingId','123','nome','Rapé A','codigo',null,
  'campo','estoque','anterior',12,'valor',5)),'deposito',jsonb_build_object('id',7,'nome','Geral'))
$$;
create function pg_temp.comando(op text,chave uuid default null,dados jsonb default null,
 ator uuid default 'a1040000-0000-4000-8000-000000000001',org uuid default 'b1040000-0000-4000-8000-000000000001')
returns jsonb language sql as $$ select public.assistente_edicao_produtos(org,ator,op,chave,dados) $$;

select ok((select relrowsecurity from pg_class where oid='public.assistente_edicoes_produtos'::regclass),'RLS habilitada');
select ok(not has_table_privilege('authenticated','public.assistente_edicoes_produtos','SELECT'),'navegador não lê propostas');
select ok(not has_table_privilege('service_role','public.assistente_edicoes_produtos','UPDATE'),'service role não altera propostas diretamente');
select ok(not has_function_privilege('anon','public.assistente_edicao_produtos(uuid,uuid,text,uuid,jsonb)','EXECUTE'),'anônimo não executa RPC');
select ok(not has_function_privilege('authenticated','public.assistente_edicao_produtos(uuid,uuid,text,uuid,jsonb)','EXECUTE'),'autenticado não executa RPC privilegiada');
select ok(has_function_privilege('service_role','public.assistente_edicao_produtos(uuid,uuid,text,uuid,jsonb)','EXECUTE'),'somente adaptador servidor chama RPC');
select throws_ok($$select pg_temp.comando('criar',null,pg_temp.conteudo(),'a1040000-0000-4000-8000-000000000003')$$,'42501',null,'membro sem gestão não propõe');
select throws_ok($$select pg_temp.comando('criar',null,pg_temp.conteudo(),'a1040000-0000-4000-8000-000000000004','b1040000-0000-4000-8000-000000000002')$$,'42501',null,'produto de outra organização é recusado');

create temp table proposta as select pg_temp.comando('criar',null,pg_temp.conteudo()) dados;
select is((select estoque from public.produtos where id='c1040000-0000-4000-8000-000000000001'),12,'prévia não altera estoque');
select is((select pg_temp.comando('reivindicar',(dados->>'chave')::uuid,null,'a1040000-0000-4000-8000-000000000002')->>'estado' from proposta),'negada','outro gestor não confirma a proposta');
select is((select pg_temp.comando('reivindicar',(dados->>'chave')::uuid,null,'a1040000-0000-4000-8000-000000000004','b1040000-0000-4000-8000-000000000002')->>'estado' from proposta),'negada','outra organização não confirma');

create temp table expirada as select pg_temp.comando('criar',null,pg_temp.conteudo()) dados;
update public.assistente_edicoes_produtos set expira_em=clock_timestamp()-interval '1 second'
 where chave=(select (dados->>'chave')::uuid from expirada);
select is((select pg_temp.comando('reivindicar',(dados->>'chave')::uuid)->>'estado' from expirada),'negada','proposta expirada não executa');
select is((select pg_temp.comando('reivindicar',(dados->>'chave')::uuid)->>'estado' from proposta),'executar','primeira confirmação reivindica');
select is((select pg_temp.comando('reivindicar',(dados->>'chave')::uuid)->>'estado' from proposta),'ocupada','repetição em andamento não reenvia');
select pg_temp.comando('registrar',(dados->>'chave')::uuid,
 jsonb_build_object('produtoId','c1040000-0000-4000-8000-000000000001','estado','aplicado')) from proposta;
select is((select estoque from public.produtos where id='c1040000-0000-4000-8000-000000000001'),5,'aceite remoto espelha apenas saldo confirmado');
select is((select nome from public.produtos where id='c1040000-0000-4000-8000-000000000001'),'Rapé A','edição de saldo preserva nome');
select pg_temp.comando('concluir',(dados->>'chave')::uuid) from proposta;
select is((select pg_temp.comando('reivindicar',(dados->>'chave')::uuid)->>'estado' from proposta),'concluida','confirmação repetida retorna recibo');
select is((select jsonb_array_length(pg_temp.comando('reivindicar',(dados->>'chave')::uuid)->'resultados') from proposta),1,'recibo não duplica itens');
select is((select count(*)::int from public.eventos_auditoria_sistema where acao='catalog.assistant_product_edit' and organizacao_id='b1040000-0000-4000-8000-000000000001'),2,'confirmação e resultado têm auditoria sem texto livre');
create temp table interrompida as select pg_temp.comando('criar',null,pg_temp.conteudo()) dados;
select pg_temp.comando('reivindicar',(dados->>'chave')::uuid) from interrompida;
select throws_ok($$select pg_temp.comando('reconciliar',(select (dados->>'chave')::uuid from interrompida),
 '{"confirmacao":"conferido_no_bling_sem_reenvio"}')$$,'22023',null,'não reconcilia uma execução que ainda pode estar ativa');
update public.assistente_edicoes_produtos set iniciado_em=clock_timestamp()-interval '20 minutes'
 where chave=(select (dados->>'chave')::uuid from interrompida);
update public.membros_organizacao set papel='member' where user_id='a1040000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.comando('reivindicar',(select (dados->>'chave')::uuid from proposta))$$,'42501',null,'revogação de gestão é conferida na confirmação');
select throws_ok($$select pg_temp.comando('reconciliar',(select (dados->>'chave')::uuid from interrompida),null,
 'a1040000-0000-4000-8000-000000000002')$$,'22023',null,'reconciliação exige declaração operacional explícita');
create temp table reconciliada as select pg_temp.comando('reconciliar',(dados->>'chave')::uuid,
 '{"confirmacao":"conferido_no_bling_sem_reenvio"}','a1040000-0000-4000-8000-000000000002') dados from interrompida;
select is((select dados->>'estado' from reconciliada),'concluida','gestor atual pode encerrar tentativa interrompida de outro ator');
select is((select jsonb_array_length(dados->'resultados') from reconciliada),1,'reconciliação cria recibo dos itens sem resultado');
select is((select dados->'resultados'->0->>'estado' from reconciliada),'indeterminado','reconciliação não inventa sucesso');
select is((select estoque from public.produtos where id='c1040000-0000-4000-8000-000000000001'),5,'reconciliação não reenvia nem altera o estoque');
select * from finish();
rollback;
