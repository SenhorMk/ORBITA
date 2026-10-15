-- escrita_direta_comercial.test.sql
-- PRE-006A, contra o schema canônico completo: o inventário da escrita direta
-- em catálogo, clientes, pedidos e estoque vira regra verificável, e a
-- migration 78 fecha o ramo legado `user_id = auth.uid()` da movimentação de
-- estoque.
--
-- As seis tabelas do escopo: produtos, categorias, movimentacao_estoque,
-- clientes, pedidos, itens_pedido.
--
-- REINTRODUZIR O DEFEITO: recrie a policy legada "Acesso a movimentacao_estoque
-- por organizacao ou user" (membro OR user_id = auth.uid(), para todos os
-- papéis): 1-4 falham (quem não é membro lê, altera, apaga e forja
-- movimentação de outra organização), 7 falha (o membro de A grava em B pelo
-- mesmo ramo), 8 falha (policy com auth.uid() direto) e 5 em cascata (medido).

begin;

select plan(12);

insert into auth.users (id, email) values
    ('a6000000-0000-4000-8000-0000000000a1', 'dono-a-t6a@orbita.test'),
    ('a6000000-0000-4000-8000-0000000000b1', 'dono-b-t6a@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('a6000000-0000-4000-8000-00000000000a', 'Org A T6A', 'org-a-t6a', 'active'),
    ('a6000000-0000-4000-8000-00000000000b', 'Org B T6A', 'org-b-t6a', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000000a1', 'owner'),
    ('a6000000-0000-4000-8000-00000000000b', 'a6000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, preco, estoque) values
    ('a6000000-0000-4000-8000-0000000000f1', 'a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000000a1', '6001', 'Produto de A', 10, 5),
    ('a6000000-0000-4000-8000-0000000000f2', 'a6000000-0000-4000-8000-00000000000b', 'a6000000-0000-4000-8000-0000000000b1', '6002', 'Produto de B', 10, 5);
-- Movimentação no livro de A gravada pelo usuário de B quando ele ainda era membro de A.
insert into public.movimentacao_estoque (id, organizacao_id, user_id, produto_id, tipo, quantidade, origem) values
    ('a6000000-0000-4000-8000-0000000000e1', 'a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000000b1',
     'a6000000-0000-4000-8000-0000000000f1', 'ENTRADA', 5, 'quando B era membro de A');

-- ----------------------------------------------------------------------------
-- 1-4. Quem não é membro de A não lê, não altera, não apaga e não forja nada no
-- livro de estoque de A — nem o que gravou quando era membro.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a6000000-0000-4000-8000-0000000000b1';
set local request.jwt.claim.role = 'authenticated';

select is((select count(*)::int from public.movimentacao_estoque where organizacao_id = 'a6000000-0000-4000-8000-00000000000a'), 0,
          '1. não membro não lê a movimentação de outra organização');
with alteradas as (
    update public.movimentacao_estoque set quantidade = 999 where id = 'a6000000-0000-4000-8000-0000000000e1' returning 1
)
select is((select count(*)::int from alteradas), 0, '2. nem a altera');
with apagadas as (
    delete from public.movimentacao_estoque where id = 'a6000000-0000-4000-8000-0000000000e1' returning 1
)
select is((select count(*)::int from apagadas), 0, '3. nem a apaga');
select throws_ok(
    $$insert into public.movimentacao_estoque (organizacao_id, user_id, produto_id, tipo, quantidade, origem)
      values ('a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000000b1',
              'a6000000-0000-4000-8000-0000000000f1', 'SAIDA', 3, 'forjado')$$,
    '42501', null, '4. nem forja movimentação no livro de outra organização');

-- ----------------------------------------------------------------------------
-- 5-7. O membro continua operando a própria organização, e só ela.
-- ----------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claim.sub = 'a6000000-0000-4000-8000-0000000000a1';
set local request.jwt.claim.role = 'authenticated';

select is((select quantidade from public.movimentacao_estoque where id = 'a6000000-0000-4000-8000-0000000000e1'), 5,
          '5. o membro lê a movimentação da própria organização, intacta');
select lives_ok(
    $$insert into public.movimentacao_estoque (organizacao_id, user_id, produto_id, tipo, quantidade, origem)
      values ('a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000000a1',
              'a6000000-0000-4000-8000-0000000000f1', 'SAIDA', 1, 'ajuste do membro')$$,
    '6. o membro grava na própria organização (o grant segue até o PRE-006D)');
select throws_ok(
    $$insert into public.movimentacao_estoque (organizacao_id, user_id, produto_id, tipo, quantidade, origem)
      values ('a6000000-0000-4000-8000-00000000000b', 'a6000000-0000-4000-8000-0000000000a1',
              'a6000000-0000-4000-8000-0000000000f2', 'SAIDA', 1, 'em B')$$,
    '42501', null, '7. e não grava em outra organização');

reset role;

-- ----------------------------------------------------------------------------
-- 8-12. O inventário como regra do catálogo.
-- ----------------------------------------------------------------------------
create temp table escopo (tabela text primary key);
insert into escopo values ('produtos'), ('categorias'), ('movimentacao_estoque'), ('clientes'), ('pedidos'), ('itens_pedido');

select is(
    (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join escopo e on e.tabela = c.relname
      where c.relnamespace = 'public'::regnamespace
        and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'auth\.uid'
             or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'auth\.uid'
             or not (p.polroles = array['authenticated'::regrole]::oid[]))),
    0, '8. toda policy do escopo é de authenticated e isola só por organização (sem ramo auth.uid())');

select is(
    (select count(*)::int from escopo e
      where not (select relrowsecurity from pg_class where oid = ('public.' || e.tabela)::regclass)),
    0, '9. RLS ligada nas seis tabelas');

select is(
    (select count(*)::int from escopo e
      where not (has_table_privilege('authenticated', 'public.' || e.tabela, 'insert')
             and has_table_privilege('authenticated', 'public.' || e.tabela, 'update')
             and has_table_privilege('authenticated', 'public.' || e.tabela, 'delete'))),
    0, '10. grants de DML de authenticated intactos nesta fatia (a revogação é do PRE-006D)');

select is(
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
        and exists (select 1 from escopo e
                     where p.prosrc ~* ('(insert\s+into|update|delete\s+from)\s+(public\.)?' || e.tabela || '\M'))),
    0, '11. nenhuma RPC executável pelo navegador (anon/authenticated) escreve nas seis tabelas');

select is(
    (select count(*)::int from pg_publication_tables pt join escopo e on e.tabela = pt.tablename
      where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'),
    0, '12. nenhuma das seis tabelas é publicada no Realtime');

select * from finish();
rollback;
