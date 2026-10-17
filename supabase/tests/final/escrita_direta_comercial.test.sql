-- escrita_direta_comercial.test.sql
-- PRE-006A + PRE-006D, contra o schema canônico completo.
--
-- As seis tabelas do escopo: produtos, categorias, movimentacao_estoque,
-- clientes, pedidos, itens_pedido.
--
-- PRE-006A provou o isolamento por organização (migration 78) e manteve o DML
-- de `authenticated`. PRE-006D (migration 81) revoga esse DML: nenhum token de
-- navegador — owner, admin ou member — escreve direto nas seis tabelas, nem
-- por coluna, nem por RPC. A leitura sob RLS continua, e os comandos do
-- servidor (`service_role`) seguem operando.
--
-- REINTRODUZIR O DEFEITO (laboratório, contraprovas do PRE-006D):
--   grant insert on public.clientes to authenticated            → 1-3, 9
--   grant update (estoque) on public.produtos to authenticated  → 4, 12
--   grant delete on public.movimentacao_estoque to authenticated → 6, 9
--   grant execute on baixar_estoque_organizacao to authenticated → 16, 28
--   revoke select on public.itens_pedido from authenticated     → 9, 19, 22
--   revoke execute on baixar_estoque_organizacao from service_role → 23
--   recriar a policy legada `organização OR user_id = auth.uid()` → 14

begin;

select plan(28);

-- ----------------------------------------------------------------------------
-- Duas organizações com uma linha em cada tabela; em A, owner, admin e member.
-- ----------------------------------------------------------------------------
insert into auth.users (id, email) values
    ('d6000000-0000-4000-8000-0000000000a1', 'dono-a-t6d@orbita.test'),
    ('d6000000-0000-4000-8000-0000000000a2', 'admin-a-t6d@orbita.test'),
    ('d6000000-0000-4000-8000-0000000000a3', 'membro-a-t6d@orbita.test'),
    ('d6000000-0000-4000-8000-0000000000b1', 'dono-b-t6d@orbita.test'),
    ('d6000000-0000-4000-8000-0000000000c1', 'de-fora-t6d@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('d6000000-0000-4000-8000-00000000000a', 'Org A T6D', 'org-a-t6d', 'active'),
    ('d6000000-0000-4000-8000-00000000000b', 'Org B T6D', 'org-b-t6d', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('d6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1', 'owner'),
    ('d6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a2', 'admin'),
    ('d6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a3', 'member'),
    ('d6000000-0000-4000-8000-00000000000b', 'd6000000-0000-4000-8000-0000000000b1', 'owner');

insert into public.categorias (id, organizacao_id, user_id, bling_id, descricao) values
    ('d6000000-0000-4000-8000-0000000000d1', 'd6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1', '6301', 'Categoria A'),
    ('d6000000-0000-4000-8000-0000000000d2', 'd6000000-0000-4000-8000-00000000000b', 'd6000000-0000-4000-8000-0000000000b1', '6302', 'Categoria B');
insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, preco, estoque) values
    ('d6000000-0000-4000-8000-0000000000f1', 'd6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1', '6401', 'Produto A', 10, 5),
    ('d6000000-0000-4000-8000-0000000000f2', 'd6000000-0000-4000-8000-00000000000b', 'd6000000-0000-4000-8000-0000000000b1', '6402', 'Produto B', 10, 5);
insert into public.clientes (id, organizacao_id, user_id, bling_id, nome) values
    ('d6000000-0000-4000-8000-0000000000e1', 'd6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1', '6501', 'Cliente A'),
    ('d6000000-0000-4000-8000-0000000000e2', 'd6000000-0000-4000-8000-00000000000b', 'd6000000-0000-4000-8000-0000000000b1', '6502', 'Cliente B');
insert into public.pedidos (id, organizacao_id, user_id, cliente_id, bling_id, numero, data, total, status, origem) values
    ('d6000000-0000-4000-8000-000000000071', 'd6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1',
     'd6000000-0000-4000-8000-0000000000e1', '6601', '6601', now(), 10, 'Pendente', 'Bling'),
    ('d6000000-0000-4000-8000-000000000072', 'd6000000-0000-4000-8000-00000000000b', 'd6000000-0000-4000-8000-0000000000b1',
     'd6000000-0000-4000-8000-0000000000e2', '6602', '6602', now(), 10, 'Pendente', 'Bling');
insert into public.itens_pedido (organizacao_id, user_id, pedido_id, produto_id, quantidade, valor_unitario) values
    ('d6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1',
     'd6000000-0000-4000-8000-000000000071', 'd6000000-0000-4000-8000-0000000000f1', 1, 10),
    ('d6000000-0000-4000-8000-00000000000b', 'd6000000-0000-4000-8000-0000000000b1',
     'd6000000-0000-4000-8000-000000000072', 'd6000000-0000-4000-8000-0000000000f2', 1, 10);
insert into public.movimentacao_estoque (organizacao_id, user_id, produto_id, tipo, quantidade, origem) values
    ('d6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1', 'd6000000-0000-4000-8000-0000000000f1', 'ENTRADA', 5, 'carga A'),
    ('d6000000-0000-4000-8000-00000000000b', 'd6000000-0000-4000-8000-0000000000b1', 'd6000000-0000-4000-8000-0000000000f2', 'ENTRADA', 5, 'carga B');

create temp table escopo (tabela text primary key);
insert into escopo values ('produtos'), ('categorias'), ('movimentacao_estoque'), ('clientes'), ('pedidos'), ('itens_pedido');
grant select on escopo to authenticated, anon;

-- Retrato das seis tabelas, para provar que nenhuma tentativa mudou nada.
create temp table retrato_antes as
select 'produtos' as tabela, md5(string_agg(t::text, '|' order by t.id)) as hash from public.produtos t
union all select 'categorias', md5(string_agg(t::text, '|' order by t.id)) from public.categorias t
union all select 'clientes', md5(string_agg(t::text, '|' order by t.id)) from public.clientes t
union all select 'pedidos', md5(string_agg(t::text, '|' order by t.id)) from public.pedidos t
union all select 'itens_pedido', md5(string_agg(t::text, '|' order by t.id)) from public.itens_pedido t
union all select 'movimentacao_estoque', md5(string_agg(t::text, '|' order by t.id)) from public.movimentacao_estoque t;

-- Tenta INSERT, UPDATE, DELETE e TRUNCATE em cada tabela. Só a recusa de
-- privilégio ("permission denied for …") conta como negação. A recusa da RLS
-- tem o mesmo SQLSTATE (42501) e significaria que o grant passou; qualquer
-- outro erro — not-null, check — também, e propaga. Se alguma escrita passar,
-- o bloco aborta citando qual.
create temp table tentativa_de_escrita (sql text);
insert into tentativa_de_escrita (sql)
select format(s, e.tabela) from escopo e cross join (values
    ('insert into public.%I default values'),
    ('update public.%I set updated_at = updated_at'),
    ('delete from public.%I'),
    ('truncate public.%I')) as v(s);
grant select on tentativa_de_escrita to authenticated, anon;

-- O corpo é repetido por papel abaixo: um DO roda com o papel corrente.

-- ----------------------------------------------------------------------------
-- 1-6. Nenhum JWT de navegador escreve: owner, admin e member de A.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';

set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000a1';
select lives_ok($t$ do $d$
    declare v_sql text; v_passou text[] := '{}';
    begin
        for v_sql in select sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                -- A RLS também responde 42501; só a falta de privilégio é negação.
                if sqlerrm not like 'permission denied for %' then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '1. owner de A não executa INSERT, UPDATE, DELETE nem TRUNCATE em nenhuma das seis tabelas');

set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000a2';
select lives_ok($t$ do $d$
    declare v_sql text; v_passou text[] := '{}';
    begin
        for v_sql in select sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                -- A RLS também responde 42501; só a falta de privilégio é negação.
                if sqlerrm not like 'permission denied for %' then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '2. admin de A também não');

set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000a3';
select lives_ok($t$ do $d$
    declare v_sql text; v_passou text[] := '{}';
    begin
        for v_sql in select sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                -- A RLS também responde 42501; só a falta de privilégio é negação.
                if sqlerrm not like 'permission denied for %' then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '3. member de A também não');

select throws_ok(
    $$update public.produtos set estoque = 999 where id = 'd6000000-0000-4000-8000-0000000000f1'$$,
    '42501', null, '4. member não altera produtos.estoque da própria organização');

set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000a1';
select throws_ok(
    $$insert into public.movimentacao_estoque (organizacao_id, user_id, produto_id, tipo, quantidade, origem)
      values ('d6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1',
              'd6000000-0000-4000-8000-0000000000f1', 'SAIDA', 3, 'forjado')$$,
    '42501', null, '5. owner não forja movimentação no livro da própria organização');

set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000a2';
select throws_ok(
    $$delete from public.movimentacao_estoque where organizacao_id = 'd6000000-0000-4000-8000-00000000000a'$$,
    '42501', null, '6. admin não apaga o livro de estoque da própria organização');

reset role;

-- ----------------------------------------------------------------------------
-- 7-8. anon também não, e nada mudou em nenhuma tabela.
-- ----------------------------------------------------------------------------
set local role anon;
set local request.jwt.claim.role = 'anon';
select lives_ok($t$ do $d$
    declare v_sql text; v_passou text[] := '{}';
    begin
        for v_sql in select sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                -- A RLS também responde 42501; só a falta de privilégio é negação.
                if sqlerrm not like 'permission denied for %' then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '7. anon não executa nenhuma escrita nas seis tabelas');
reset role;

select is(
    (select count(*)::int from retrato_antes a
       join (select 'produtos' as tabela, md5(string_agg(t::text, '|' order by t.id)) as hash from public.produtos t
             union all select 'categorias', md5(string_agg(t::text, '|' order by t.id)) from public.categorias t
             union all select 'clientes', md5(string_agg(t::text, '|' order by t.id)) from public.clientes t
             union all select 'pedidos', md5(string_agg(t::text, '|' order by t.id)) from public.pedidos t
             union all select 'itens_pedido', md5(string_agg(t::text, '|' order by t.id)) from public.itens_pedido t
             union all select 'movimentacao_estoque', md5(string_agg(t::text, '|' order by t.id)) from public.movimentacao_estoque t) d
         on d.tabela = a.tabela and d.hash = a.hash),
    6, '8. depois de todas as tentativas, as seis tabelas estão idênticas');

-- ----------------------------------------------------------------------------
-- 9-13. Matriz de privilégios efetivos (não só os grants visíveis).
-- ----------------------------------------------------------------------------
select is(
    (select count(*)::int from escopo e
      where not has_table_privilege('authenticated', 'public.' || e.tabela, 'SELECT')
         or has_table_privilege('authenticated', 'public.' || e.tabela, 'INSERT')
         or has_table_privilege('authenticated', 'public.' || e.tabela, 'UPDATE')
         or has_table_privilege('authenticated', 'public.' || e.tabela, 'DELETE')
         or has_table_privilege('authenticated', 'public.' || e.tabela, 'TRUNCATE')),
    0, '9. authenticated: só SELECT nas seis tabelas (o DML foi revogado no PRE-006D)');
select is(
    (select count(*)::int from escopo e cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
      where has_table_privilege('anon', 'public.' || e.tabela, p.priv)),
    0, '10. anon: nenhum privilégio nas seis tabelas');
select is(
    (select count(*)::int from escopo e join pg_class c on c.oid = ('public.' || e.tabela)::regclass
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where a.grantee = 0),
    0, '11. PUBLIC: nenhuma entrada de ACL nas seis tabelas');
select is(
    (select count(*)::int from escopo e
       join pg_attribute a on a.attrelid = ('public.' || e.tabela)::regclass and a.attnum > 0 and not a.attisdropped
       cross join (values ('authenticated'), ('anon')) r(papel)
      where has_column_privilege(r.papel, a.attrelid, a.attname, 'INSERT')
         or has_column_privilege(r.papel, a.attrelid, a.attname, 'UPDATE')),
    0, '12. nenhuma coluna das seis tabelas é gravável por authenticated ou anon');
select is(
    (select count(*)::int from escopo e cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
      where not has_table_privilege('service_role', 'public.' || e.tabela, p.priv)),
    0, '13. service_role mantém SELECT, INSERT, UPDATE e DELETE (comandos do servidor)');

-- ----------------------------------------------------------------------------
-- 14-18. Policies, RLS, RPCs e Realtime.
-- ----------------------------------------------------------------------------
select is(
    (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join escopo e on e.tabela = c.relname
      where c.relnamespace = 'public'::regnamespace
        and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'auth\.uid'
             or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'auth\.uid'
             or not (p.polroles = array['authenticated'::regrole]::oid[]))),
    0, '14. toda policy do escopo é de authenticated e isola só por organização (sem ramo auth.uid())');
select is(
    (select count(*)::int from escopo e
      where not (select relrowsecurity from pg_class where oid = ('public.' || e.tabela)::regclass)),
    0, '15. RLS ligada nas seis tabelas');

-- Funções de extensão (pgTAP instalado em `public`, por exemplo) não são RPC
-- do produto: ficam de fora, senão o resultado depende de onde a extensão mora.
create temp table funcoes_do_produto as
select p.oid, p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');

create temp table funcoes_que_escrevem as
select p.oid, p.proname from funcoes_do_produto p
 where exists (select 1 from escopo e where p.prosrc ~* ('(insert\s+into|update|delete\s+from|truncate)\s+(public\.)?' || e.tabela || '\M'));

select is(
    (select count(*)::int from funcoes_que_escrevem f
      where has_function_privilege('authenticated', f.oid, 'execute') or has_function_privilege('anon', f.oid, 'execute')),
    0, '16. nenhuma RPC executável pelo navegador escreve nas seis tabelas');
select is(
    (select count(*)::int from funcoes_do_produto p
      where (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
        and (exists (select 1 from funcoes_que_escrevem f where f.oid <> p.oid and p.prosrc ~* ('\m' || f.proname || '\s*\('))
             or p.prosrc ~* '\mexecute\s+(format|''|[a-z_]+\s*(\|\||;|using))')),
    0, '17. nem indiretamente: nenhuma delas chama função que escreve, nem monta SQL dinâmico');
select is(
    (select count(*)::int from pg_publication_tables pt join escopo e on e.tabela = pt.tablename
      where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'),
    0, '18. nenhuma das seis tabelas é publicada no Realtime');

-- ----------------------------------------------------------------------------
-- 19-22. A leitura das telas continua, só da própria organização.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000a3';

select is(
    (select (select count(*) from public.produtos) || ',' || (select count(*) from public.categorias) || ',' ||
            (select count(*) from public.clientes) || ',' || (select count(*) from public.pedidos) || ',' ||
            (select count(*) from public.itens_pedido) || ',' || (select count(*) from public.movimentacao_estoque)),
    '1,1,1,1,1,1', '19. member de A lê as seis tabelas da própria organização');
select is(
    (select count(*)::int from public.produtos where organizacao_id = 'd6000000-0000-4000-8000-00000000000b')
      + (select count(*)::int from public.pedidos where organizacao_id = 'd6000000-0000-4000-8000-00000000000b')
      + (select count(*)::int from public.movimentacao_estoque where organizacao_id = 'd6000000-0000-4000-8000-00000000000b'),
    0, '20. e não lê nada de B');

set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000c1';
select is(
    (select count(*)::int from public.produtos) + (select count(*)::int from public.clientes)
      + (select count(*)::int from public.pedidos) + (select count(*)::int from public.itens_pedido),
    0, '21. quem não é membro não lê nada');

set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000a3';
select is(
    (select string_agg(p.nome || ':' || i.quantidade, ',') from public.itens_pedido i
       join public.produtos p on p.id = i.produto_id
      where i.pedido_id = 'd6000000-0000-4000-8000-000000000071'),
    'Produto A:1', '22. a leitura da tela de pedidos (itens com o produto embutido) funciona');

-- ----------------------------------------------------------------------------
-- 23-26. Os comandos do servidor seguem operando, no escopo da organização.
-- ----------------------------------------------------------------------------
reset role;
set local role service_role;
set local request.jwt.claim.role = 'service_role';

select is(
    (select estoque_restante from public.baixar_estoque_organizacao(
        'd6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000f1', 1, 'd6000000-0000-4000-8000-0000000000a1')),
    4, '23. a baixa da venda manual (service_role) funciona');
select is(
    (select desfecho from public.alinhar_estoque_ao_saldo_do_bling(
        'd6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1', 'd6000000-0000-4000-8000-0000000000f1', 4, 6)),
    'alinhado', '24. o alinhamento ao saldo do Bling (service_role) funciona');
select is(
    (select count(*)::int from public.movimentacao_estoque
      where produto_id = 'd6000000-0000-4000-8000-0000000000f1'
        and origem in ('BAIXA_ORGANIZACAO_VERIFICADA', 'ALINHAMENTO_SITUACAO_BLING')),
    2, '25. e o livro de estoque registra os dois movimentos');
with alterados as (
    update public.clientes set nome = 'Cliente A editado'
     where id = 'd6000000-0000-4000-8000-0000000000e1' and organizacao_id = 'd6000000-0000-4000-8000-00000000000a'
    returning 1
)
select is((select count(*)::int from alterados), 1,
          '26. o repositório do servidor (service_role, filtro de organização) grava em clientes');

reset role;

-- ----------------------------------------------------------------------------
-- 27-28. O navegador não produz auditoria nem baixa estoque por RPC.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'd6000000-0000-4000-8000-0000000000a1';
select throws_ok(
    $$select public.registrar_evento_auditoria('d6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-0000000000a1',
        'catalog.product_saved', 'produto', null, 'corr_t6d', null, null, '{}'::jsonb)$$,
    '42501', null, '27. o owner não forja evento de auditoria pelo navegador');
select throws_ok(
    $$select * from public.baixar_estoque_organizacao('d6000000-0000-4000-8000-00000000000a',
        'd6000000-0000-4000-8000-0000000000f1', 1, 'd6000000-0000-4000-8000-0000000000a1')$$,
    '42501', null, '28. nem baixa estoque chamando a RPC do servidor');
reset role;

select * from finish();
rollback;
