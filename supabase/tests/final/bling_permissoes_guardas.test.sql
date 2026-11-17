-- Contrato PostgreSQL integrado. Simula o papel do PostgREST com fixtures sintéticas.
begin;

insert into auth.users (id, email) values
    ('96000000-0000-4000-8000-0000000000f1','owner-96@orbita.test'),
    ('96000000-0000-4000-8000-0000000000f2','member-96@orbita.test'),
    ('96000000-0000-4000-8000-0000000000f3','owner-b-96@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('96000000-0000-4000-8000-0000000000a1','Fixture A','bling-fix-a','active'),
    ('96000000-0000-4000-8000-0000000000b1','Fixture B','bling-fix-b','active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f1','owner'),
    ('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f2','member'),
    ('96000000-0000-4000-8000-0000000000b1','96000000-0000-4000-8000-0000000000f3','owner');

select plan(22);
select is((select count(*)::int from pg_proc p where p.oid in (
    'public.fn_travar_bling_id_de_contato(uuid,text)'::regprocedure,
    'public.fn_travar_bling_id_de_produto(uuid,text)'::regprocedure,
    'public.fn_marcar_contato_no_ciclo(uuid,timestamptz,timestamptz)'::regprocedure,
    'public.fn_exigir_administrador_da_organizacao(uuid,uuid)'::regprocedure
) and not p.prosecdef and has_function_privilege('service_role', p.oid, 'execute')
  and not has_function_privilege('anon', p.oid, 'execute')
  and not has_function_privilege('authenticated', p.oid, 'execute')),
    4, 'somente o papel de servidor executa as quatro guardas, todas invoker');

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select lives_ok($q$insert into public.clientes(organizacao_id,user_id,bling_id,nome) values
('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f1','960001','Cliente A'),
('96000000-0000-4000-8000-0000000000b1','96000000-0000-4000-8000-0000000000f3','960001','Cliente B')
on conflict (organizacao_id,bling_id) do update set nome=excluded.nome$q$, 'upsert inicial de contatos A e B');
select lives_ok($q$insert into public.clientes(organizacao_id,user_id,bling_id,nome) values
('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f1','960001','Contato A editado')
on conflict (organizacao_id,bling_id) do update set nome=excluded.nome$q$, 'upsert usa o índice real para atualizar contato');
select is((select nome from public.clientes where organizacao_id='96000000-0000-4000-8000-0000000000b1' and bling_id='960001'),
    'Cliente B','identificador externo compartilhado não regrava B');

select lives_ok($q$insert into public.produtos(organizacao_id,user_id,bling_id,nome) values
('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f1','960001','Produto A'),
('96000000-0000-4000-8000-0000000000b1','96000000-0000-4000-8000-0000000000f3','960001','Produto B')
on conflict (organizacao_id,bling_id) do update set nome=excluded.nome$q$, 'upsert inicial de produtos A e B');
select lives_ok($q$insert into public.produtos(organizacao_id,user_id,bling_id,nome) values
('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f1','960001','Produto A editado')
on conflict (organizacao_id,bling_id) do update set nome=excluded.nome$q$, 'upsert atualiza o produto existente');

select is((select desfecho from public.registrar_exclusao_de_produto_no_bling(
    '96000000-0000-4000-8000-0000000000a1','960001',now())),
    'registrado','exclusão arquiva produto e persiste tombstone');
select is((select situacao from public.produtos where organizacao_id='96000000-0000-4000-8000-0000000000a1' and bling_id='960001'),
    'arquivado','produto de A foi arquivado');
select is((select situacao from public.produtos where organizacao_id='96000000-0000-4000-8000-0000000000b1' and bling_id='960001'),
    'ativo','tombstone de A preserva produto de B');
select throws_ok($q$insert into public.produtos(organizacao_id,user_id,bling_id,nome) values
('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f1','960001','Atrasado')
on conflict (organizacao_id,bling_id) do update set nome=excluded.nome$q$,'23514',null,'produto excluído não ressuscita no upsert');

select is((select desfecho from public.registrar_exclusao_de_contato_no_bling(
    '96000000-0000-4000-8000-0000000000a1','960001',now(),'sintetico-a')),
    'registrado','exclusão aciona a marca de ciclo sob service_role');
select ok((select excluido_no_bling_em is not null from public.clientes
    where organizacao_id='96000000-0000-4000-8000-0000000000a1' and bling_id='960001'),'contato A marcado');
select throws_ok($q$insert into public.clientes(organizacao_id,user_id,bling_id,nome) values
('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f1','960001','Atrasado')
on conflict (organizacao_id,bling_id) do update set nome=excluded.nome$q$,'23514',null,'contato excluído não ressuscita no upsert');
select throws_ok($q$select * from public.reativar_contato_excluido_no_bling(
    '96000000-0000-4000-8000-0000000000a1','960001','96000000-0000-4000-8000-0000000000f2')$q$,
    '42501','Somente quem administra a organizacao reconcilia um contato.','ator membro é negado mesmo via service_role');
select throws_ok($q$select * from public.reativar_contato_excluido_no_bling(
    '96000000-0000-4000-8000-0000000000a1','960001','96000000-0000-4000-8000-0000000000f3')$q$,
    '42501','Somente quem administra a organizacao reconcilia um contato.','owner de B não reativa contato de A');
select is((select desfecho from public.reativar_contato_excluido_no_bling(
    '96000000-0000-4000-8000-0000000000a1','960001','96000000-0000-4000-8000-0000000000f1')),
    'reativado','owner de A reativa pela RPC');
select lives_ok($q$insert into public.clientes(organizacao_id,user_id,bling_id,nome) values
('96000000-0000-4000-8000-0000000000a1','96000000-0000-4000-8000-0000000000f1','960001','Contato reativado')
on conflict (organizacao_id,bling_id) do update set nome=excluded.nome$q$, 'upsert volta após reativação autorizada');
select is((select desfecho from public.registrar_exclusao_de_contato_no_bling(
    '96000000-0000-4000-8000-0000000000a1','960001',null,'sintetico-pendente')),
    'reconciliacao_necessaria','exclusão sem data após reativação exige confirmação');
select is((select desfecho from public.confirmar_exclusao_pendente_de_contato(
    '96000000-0000-4000-8000-0000000000a1','960001','96000000-0000-4000-8000-0000000000f1')),
    'confirmada','owner confirma pendência mantendo as guardas');
select throws_ok($q$insert into public.integracoes_bling default values$q$,
    '42501','permission denied for table integracoes_bling','servidor continua sem escrita na tabela legada');

reset role;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select throws_ok($q$select public.fn_travar_bling_id_de_contato('96000000-0000-4000-8000-0000000000a1','960001')$q$,
    '42501','permission denied for function fn_travar_bling_id_de_contato','browser sem acesso à guarda');
select throws_ok($q$select * from public.reativar_contato_excluido_no_bling(
    '96000000-0000-4000-8000-0000000000a1','960001','96000000-0000-4000-8000-0000000000f1')$q$,
    '42501','permission denied for function reativar_contato_excluido_no_bling','browser sem acesso ao comando');
reset role;
select * from finish();
rollback;
