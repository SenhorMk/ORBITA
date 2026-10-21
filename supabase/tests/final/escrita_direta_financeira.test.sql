-- escrita_direta_financeira.test.sql
-- PRE-007A, contra o schema canônico completo (migration 82).
--
-- As quatro tabelas do escopo: titulos_financeiros, fornecedores,
-- contas_financeiras, categorias_financeiras.
--
-- Nenhum token de navegador — owner, admin ou member, da organização ou de
-- outra — escreve direto nas quatro tabelas: não marca título como pago, não
-- altera o valor, não forja nem apaga lançamento. A leitura sob RLS continua
-- por membership. As correções locais de título (`*_auditad{o,a}`) gravam o
-- efeito e o evento na mesma transação: se a auditoria falha, nada muda.
--
-- REINTRODUZIR O DEFEITO (laboratório, contraprovas do PRE-007A):
--   grant update on public.titulos_financeiros to authenticated        → 1-5, 7, 10, 13
--   grant update (situacao) on public.titulos_financeiros to authenticated → 4, 13
--   grant insert on public.fornecedores to authenticated               → 1-3, 10, 13
--   grant execute on excluir_lancamento_interno_auditado to authenticated → 17, 23
--   grant execute on marcar_titulo_pago_conta_pagar to authenticated     → 17, 24
--   cancelar sem a chamada de auditoria                                → 31-34
--   excluir sem a chamada de auditoria (DELETE e return 1)             → 25, 26, 29, 30
--   recriar a policy legada `organização OR user_id = auth.uid()`      → 15

begin;

select plan(39);

-- ----------------------------------------------------------------------------
-- Duas organizações com uma linha em cada tabela; em A, owner, admin e member.
-- ----------------------------------------------------------------------------
insert into auth.users (id, email) values
    ('d7000000-0000-4000-8000-0000000000a1', 'dono-a-t7a@orbita.test'),
    ('d7000000-0000-4000-8000-0000000000a2', 'admin-a-t7a@orbita.test'),
    ('d7000000-0000-4000-8000-0000000000a3', 'membro-a-t7a@orbita.test'),
    ('d7000000-0000-4000-8000-0000000000b1', 'dono-b-t7a@orbita.test'),
    ('d7000000-0000-4000-8000-0000000000c1', 'de-fora-t7a@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('d7000000-0000-4000-8000-00000000000a', 'Org A T7A', 'org-a-t7a', 'active'),
    ('d7000000-0000-4000-8000-00000000000b', 'Org B T7A', 'org-b-t7a', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('d7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1', 'owner'),
    ('d7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a2', 'admin'),
    ('d7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a3', 'member'),
    ('d7000000-0000-4000-8000-00000000000b', 'd7000000-0000-4000-8000-0000000000b1', 'owner');

insert into public.categorias_financeiras (id, organizacao_id, user_id, bling_id, descricao, tipo) values
    ('d7000000-0000-4000-8000-0000000000d1', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1', 7301, 'Categoria A', 'despesa'),
    ('d7000000-0000-4000-8000-0000000000d2', 'd7000000-0000-4000-8000-00000000000b', 'd7000000-0000-4000-8000-0000000000b1', 7302, 'Categoria B', 'despesa');
insert into public.contas_financeiras (id, organizacao_id, user_id, bling_id, descricao) values
    ('d7000000-0000-4000-8000-0000000000e1', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1', 7401, 'Conta A'),
    ('d7000000-0000-4000-8000-0000000000e2', 'd7000000-0000-4000-8000-00000000000b', 'd7000000-0000-4000-8000-0000000000b1', 7402, 'Conta B');
insert into public.fornecedores (id, organizacao_id, user_id, bling_id, nome) values
    ('d7000000-0000-4000-8000-0000000000f1', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1', 7501, 'Fornecedor A'),
    ('d7000000-0000-4000-8000-0000000000f2', 'd7000000-0000-4000-8000-00000000000b', 'd7000000-0000-4000-8000-0000000000b1', 7502, 'Fornecedor B');
-- Em A: uma despesa interna aberta (71), uma do Bling aberta (72). Em B: uma aberta (73).
insert into public.titulos_financeiros (id, organizacao_id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao) values
    ('d7000000-0000-4000-8000-000000000071', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1',
     null, 'pagar', 'aberto', 100.00, '2026-11-10', 'Despesa interna A'),
    ('d7000000-0000-4000-8000-000000000072', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1',
     7601, 'pagar', 'aberto', 250.00, '2026-11-10', 'Despesa do Bling A'),
    ('d7000000-0000-4000-8000-000000000073', 'd7000000-0000-4000-8000-00000000000b', 'd7000000-0000-4000-8000-0000000000b1',
     null, 'pagar', 'aberto', 300.00, '2026-11-10', 'Despesa interna B');
-- Em A, uma despesa do Bling vinculada a um pedido (74).
insert into public.clientes (id, organizacao_id, user_id, bling_id, nome) values
    ('d7000000-0000-4000-8000-0000000000c7', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1', '7701', 'Cliente A');
insert into public.pedidos (id, organizacao_id, user_id, cliente_id, bling_id, numero, data, total, status, origem) values
    ('d7000000-0000-4000-8000-0000000000e7', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1',
     'd7000000-0000-4000-8000-0000000000c7', '7801', '7801', now(), 10, 'Pendente', 'Bling');
insert into public.titulos_financeiros (id, organizacao_id, user_id, bling_id, pedido_id, tipo, situacao, valor, data_vencimento, descricao) values
    ('d7000000-0000-4000-8000-000000000074', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1',
     7602, 'd7000000-0000-4000-8000-0000000000e7', 'pagar', 'aberto', 50.00, '2026-11-10', 'Despesa do pedido A');

create temp table escopo (tabela text primary key);
insert into escopo values ('titulos_financeiros'), ('fornecedores'), ('contas_financeiras'), ('categorias_financeiras');
grant select on escopo to authenticated, anon;

-- Retrato das quatro tabelas, para provar que nenhuma tentativa mudou nada.
create temp table retrato_antes as
select 'titulos_financeiros' as tabela, md5(string_agg(t::text, '|' order by t.id)) as hash from public.titulos_financeiros t
union all select 'fornecedores', md5(string_agg(t::text, '|' order by t.id)) from public.fornecedores t
union all select 'contas_financeiras', md5(string_agg(t::text, '|' order by t.id)) from public.contas_financeiras t
union all select 'categorias_financeiras', md5(string_agg(t::text, '|' order by t.id)) from public.categorias_financeiras t;

-- Tenta INSERT, UPDATE, DELETE e TRUNCATE em cada tabela. Só a recusa de
-- privilégio **na própria tabela** conta como negação. A RLS responde o
-- mesmo SQLSTATE (42501) e significaria que o grant passou; o gatilho do
-- PRE-002 lê `tentativas_conta_pagar` e também pode responder 42501, mas
-- sobre outra tabela, depois de o UPDATE já ter sido permitido. `set id = id`
-- vale para as quatro (categorias_financeiras não tem updated_at).
create temp table tentativa_de_escrita (tabela text, sql text);
insert into tentativa_de_escrita (tabela, sql)
select e.tabela, format(s, e.tabela) from escopo e cross join (values
    ('insert into public.%I default values'),
    ('update public.%I set id = id'),
    ('delete from public.%I'),
    ('truncate public.%I')) as v(s);
grant select on tentativa_de_escrita to authenticated, anon;

-- ----------------------------------------------------------------------------
-- 1-7. Nenhum JWT de navegador escreve: owner, admin e member de A; owner de B.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';

set local request.jwt.claim.sub = 'd7000000-0000-4000-8000-0000000000a1';
select lives_ok($t$ do $d$
    declare v_tabela text; v_sql text; v_passou text[] := '{}';
    begin
        for v_tabela, v_sql in select tabela, sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                if sqlerrm <> 'permission denied for table ' || v_tabela then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '1. owner de A não executa INSERT, UPDATE, DELETE nem TRUNCATE em nenhuma das quatro tabelas');

set local request.jwt.claim.sub = 'd7000000-0000-4000-8000-0000000000a2';
select lives_ok($t$ do $d$
    declare v_tabela text; v_sql text; v_passou text[] := '{}';
    begin
        for v_tabela, v_sql in select tabela, sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                if sqlerrm <> 'permission denied for table ' || v_tabela then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '2. admin de A também não');

set local request.jwt.claim.sub = 'd7000000-0000-4000-8000-0000000000a3';
select lives_ok($t$ do $d$
    declare v_tabela text; v_sql text; v_passou text[] := '{}';
    begin
        for v_tabela, v_sql in select tabela, sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                if sqlerrm <> 'permission denied for table ' || v_tabela then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '3. member de A também não');

select throws_ok(
    $$update public.titulos_financeiros set situacao = 'pago'
       where id = 'd7000000-0000-4000-8000-000000000071'$$,
    '42501', 'permission denied for table titulos_financeiros', '4. member não marca como pago um título da própria organização');
select throws_ok(
    $$update public.titulos_financeiros set valor = 1.00 where id = 'd7000000-0000-4000-8000-000000000072'$$,
    '42501', 'permission denied for table titulos_financeiros', '5. member não altera o montante de um título da própria organização');

set local request.jwt.claim.sub = 'd7000000-0000-4000-8000-0000000000a1';
select throws_ok(
    $$insert into public.titulos_financeiros (organizacao_id, user_id, tipo, situacao, valor, data_vencimento, descricao)
      values ('d7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1',
              'receber', 'pago', 9999.00, '2026-11-10', 'forjado')$$,
    '42501', 'permission denied for table titulos_financeiros', '6. owner não forja um título pago na própria organização');

set local request.jwt.claim.sub = 'd7000000-0000-4000-8000-0000000000b1';
select throws_ok(
    $$update public.titulos_financeiros set situacao = 'pago', valor = 1.00
       where organizacao_id = 'd7000000-0000-4000-8000-00000000000a'$$,
    '42501', 'permission denied for table titulos_financeiros', '7. owner de B não marca pago nem altera o montante de títulos de A');

reset role;

-- ----------------------------------------------------------------------------
-- 8-9. anon também não, e nada mudou em nenhuma tabela.
-- ----------------------------------------------------------------------------
set local role anon;
set local request.jwt.claim.role = 'anon';
select lives_ok($t$ do $d$
    declare v_tabela text; v_sql text; v_passou text[] := '{}';
    begin
        for v_tabela, v_sql in select tabela, sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                if sqlerrm <> 'permission denied for table ' || v_tabela then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '8. anon não executa nenhuma escrita nas quatro tabelas');
reset role;

select is(
    (select count(*)::int from retrato_antes a
       join (select 'titulos_financeiros' as tabela, md5(string_agg(t::text, '|' order by t.id)) as hash from public.titulos_financeiros t
             union all select 'fornecedores', md5(string_agg(t::text, '|' order by t.id)) from public.fornecedores t
             union all select 'contas_financeiras', md5(string_agg(t::text, '|' order by t.id)) from public.contas_financeiras t
             union all select 'categorias_financeiras', md5(string_agg(t::text, '|' order by t.id)) from public.categorias_financeiras t) d
         on d.tabela = a.tabela and d.hash = a.hash),
    4, '9. depois de todas as tentativas, as quatro tabelas estão idênticas');

-- ----------------------------------------------------------------------------
-- 10-14. Matriz de privilégios efetivos (não só os grants visíveis).
-- ----------------------------------------------------------------------------
select is(
    (select count(*)::int from escopo e
      where not has_table_privilege('authenticated', 'public.' || e.tabela, 'SELECT')
         or has_table_privilege('authenticated', 'public.' || e.tabela, 'INSERT')
         or has_table_privilege('authenticated', 'public.' || e.tabela, 'UPDATE')
         or has_table_privilege('authenticated', 'public.' || e.tabela, 'DELETE')
         or has_table_privilege('authenticated', 'public.' || e.tabela, 'TRUNCATE')),
    0, '10. authenticated: só SELECT nas quatro tabelas (o DML foi revogado no PRE-007A)');
select is(
    (select count(*)::int from escopo e cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
      where has_table_privilege('anon', 'public.' || e.tabela, p.priv)),
    0, '11. anon: nenhum privilégio nas quatro tabelas');
select is(
    (select count(*)::int from escopo e join pg_class c on c.oid = ('public.' || e.tabela)::regclass
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where a.grantee = 0),
    0, '12. PUBLIC: nenhuma entrada de ACL nas quatro tabelas');
select is(
    (select count(*)::int from escopo e
       join pg_attribute a on a.attrelid = ('public.' || e.tabela)::regclass and a.attnum > 0 and not a.attisdropped
       cross join (values ('authenticated'), ('anon')) r(papel)
      where has_column_privilege(r.papel, a.attrelid, a.attname, 'INSERT')
         or has_column_privilege(r.papel, a.attrelid, a.attname, 'UPDATE')),
    0, '13. nenhuma coluna das quatro tabelas é gravável por authenticated ou anon (nem situacao, nem valor)');
select is(
    (select count(*)::int from escopo e cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
      where not has_table_privilege('service_role', 'public.' || e.tabela, p.priv)),
    0, '14. service_role mantém SELECT, INSERT, UPDATE e DELETE (comandos do servidor)');

-- ----------------------------------------------------------------------------
-- 15-19. Policies, RLS, RPCs e Realtime.
-- ----------------------------------------------------------------------------
select is(
    (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join escopo e on e.tabela = c.relname
      where c.relnamespace = 'public'::regnamespace
        and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'auth\.uid'
             or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'auth\.uid'
             or not (p.polroles = array['authenticated'::regrole]::oid[]))),
    0, '15. toda policy do escopo é de authenticated e isola só por organização (sem ramo auth.uid())');
select is(
    (select count(*)::int from escopo e
      where not (select relrowsecurity from pg_class where oid = ('public.' || e.tabela)::regclass)),
    0, '16. RLS ligada nas quatro tabelas');

-- Funções de extensão (pgTAP em `public`, por exemplo) não são RPC do produto.
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
    0, '17. nenhuma RPC executável pelo navegador escreve nas quatro tabelas');
select is(
    (select count(*)::int from funcoes_do_produto p
      where (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
        and (exists (select 1 from funcoes_que_escrevem f where f.oid <> p.oid and p.prosrc ~* ('\m' || f.proname || '\s*\('))
             or p.prosrc ~* '\mexecute\s+(format|''|[a-z_]+\s*(\|\||;|using))')),
    0, '18. nem indiretamente: nenhuma delas chama função que escreve, nem monta SQL dinâmico');
select is(
    (select count(*)::int from pg_publication_tables pt join escopo e on e.tabela = pt.tablename
      where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'),
    0, '19. nenhuma das quatro tabelas é publicada no Realtime');

-- ----------------------------------------------------------------------------
-- 20-22. A leitura continua conforme a membership.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'd7000000-0000-4000-8000-0000000000a3';

select is(
    (select (select count(*) from public.titulos_financeiros) || ',' || (select count(*) from public.fornecedores) || ',' ||
            (select count(*) from public.contas_financeiras) || ',' || (select count(*) from public.categorias_financeiras)),
    '3,1,1,1', '20. member de A lê as quatro tabelas da própria organização');
select is(
    (select count(*)::int from public.titulos_financeiros where organizacao_id = 'd7000000-0000-4000-8000-00000000000b')
      + (select count(*)::int from public.fornecedores where organizacao_id = 'd7000000-0000-4000-8000-00000000000b'),
    0, '21. e não lê nada de B');

set local request.jwt.claim.sub = 'd7000000-0000-4000-8000-0000000000c1';
select is(
    (select count(*)::int from public.titulos_financeiros) + (select count(*)::int from public.fornecedores)
      + (select count(*)::int from public.contas_financeiras) + (select count(*)::int from public.categorias_financeiras),
    0, '22. quem não é membro não lê nada');

-- ----------------------------------------------------------------------------
-- 23-24. O navegador não chama as RPCs do servidor que mudam títulos.
-- ----------------------------------------------------------------------------
set local request.jwt.claim.sub = 'd7000000-0000-4000-8000-0000000000a1';
select throws_ok(
    $$select public.excluir_lancamento_interno_auditado('d7000000-0000-4000-8000-00000000000a',
        'd7000000-0000-4000-8000-0000000000a1', 'd7000000-0000-4000-8000-000000000071', 'corr_t7a')$$,
    '42501', 'permission denied for function excluir_lancamento_interno_auditado',
    '23. o owner não exclui lançamento chamando a RPC do servidor');
select throws_ok(
    $$select public.marcar_titulo_pago_conta_pagar('d7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-000000000072')$$,
    '42501', 'permission denied for function marcar_titulo_pago_conta_pagar',
    '24. nem marca título como pago pela RPC da quitação comprovada');
reset role;

-- ----------------------------------------------------------------------------
-- 25-39. Comandos do servidor: escopo da organização e auditoria obrigatória.
-- ----------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claim.role = 'service_role';

-- Ator sem membership: `registrar_evento_auditoria` recusa o evento, e o
-- DELETE da mesma transação é desfeito.
select throws_like(
    $$select public.excluir_lancamento_interno_auditado('d7000000-0000-4000-8000-00000000000a',
        'd7000000-0000-4000-8000-0000000000c1', 'd7000000-0000-4000-8000-000000000071', 'corr_t7a_falha')$$,
    '%evento de auditoria recusado (anti-forjamento cross-tenant)%', '25. auditoria recusada: a exclusão falha');
select is(
    (select count(*)::int from public.titulos_financeiros where id = 'd7000000-0000-4000-8000-000000000071')
      || ':' || (select count(*)::int from public.eventos_auditoria_sistema where correlation_id = 'corr_t7a_falha'),
    '1:0', '26. e o lançamento continua lá, sem evento: a falha da auditoria abortou a mutação');

select is(
    public.excluir_lancamento_interno_auditado('d7000000-0000-4000-8000-00000000000b',
        'd7000000-0000-4000-8000-0000000000b1', 'd7000000-0000-4000-8000-000000000071', 'corr_t7a_cruzado'),
    0, '27. a organização B não exclui o lançamento de A, mesmo com service_role');

select is(
    public.excluir_lancamento_interno_auditado('d7000000-0000-4000-8000-00000000000a',
        'd7000000-0000-4000-8000-0000000000a1', 'd7000000-0000-4000-8000-000000000072', 'corr_t7a_bling'),
    0, '28. despesa do Bling não sai pela exclusão de lançamento interno');

select is(
    public.excluir_lancamento_interno_auditado('d7000000-0000-4000-8000-00000000000a',
        'd7000000-0000-4000-8000-0000000000a2', 'd7000000-0000-4000-8000-000000000071', 'corr_t7a_ok'),
    1, '29. fluxo autorizado: o admin de A exclui o lançamento interno');
select is(
    (select count(*)::int from public.titulos_financeiros where id = 'd7000000-0000-4000-8000-000000000071')
      || ':' || (select string_agg(e.acao || '/' || e.actor_id || '/' || (e.metadata ->> 'situacao_anterior'), ',')
                   from public.eventos_auditoria_sistema e
                  where e.organizacao_id = 'd7000000-0000-4000-8000-00000000000a' and e.correlation_id = 'corr_t7a_ok'),
    '0:finance.entry_deleted/d7000000-0000-4000-8000-0000000000a2/aberto',
    '30. a linha saiu e o evento foi gravado uma vez, com o ator e a situação anterior');

select throws_ok(
    $$select public.cancelar_despesa_local_auditada('d7000000-0000-4000-8000-00000000000a',
        'd7000000-0000-4000-8000-0000000000a1', 'd7000000-0000-4000-8000-000000000072', 'corr_t7a_ev', 'qualquer_coisa')$$,
    '22023', null, '31. cancelamento sem evidência válida é recusado');
select throws_like(
    $$select public.cancelar_despesa_local_auditada('d7000000-0000-4000-8000-00000000000a',
        'd7000000-0000-4000-8000-0000000000c1', 'd7000000-0000-4000-8000-000000000072', 'corr_t7a_cfalha', 'remoto_ausente')$$,
    '%evento de auditoria recusado (anti-forjamento cross-tenant)%',
    '32. auditoria recusada: a conclusão local do cancelamento falha');
-- Cada verificação em instrução própria: subselects da mesma instrução veem o
-- snapshot de antes da função.
select is(
    public.cancelar_despesa_local_auditada('d7000000-0000-4000-8000-00000000000a',
        'd7000000-0000-4000-8000-0000000000a1', 'd7000000-0000-4000-8000-000000000072', 'corr_t7a_cancel', 'remoto_ausente'),
    1, '33. fluxo autorizado: depois da falha o título seguia ativo, e agora o owner conclui o cancelamento');
select is(
    (select situacao from public.titulos_financeiros where id = 'd7000000-0000-4000-8000-000000000072')
      || ':' || (select string_agg(e.correlation_id || '/' || (e.metadata ->> 'bling_id') || '/' || (e.metadata ->> 'evidencia'), ',')
                   from public.eventos_auditoria_sistema e
                  where e.acao = 'finance.expense_cancelled' and e.correlation_id like 'corr_t7a_c%'),
    'cancelado:corr_t7a_cancel/7601/remoto_ausente',
    '34. a despesa ficou cancelada no histórico, com um único evento (o da tentativa recusada não existe)');

select is(
    public.cancelar_despesa_local_auditada('d7000000-0000-4000-8000-00000000000a',
        'd7000000-0000-4000-8000-0000000000a1', 'd7000000-0000-4000-8000-000000000074', 'corr_t7a_pedido', 'remoto_ausente')
      || ':' || (select situacao from public.titulos_financeiros where id = 'd7000000-0000-4000-8000-000000000074'),
    '0:aberto', '35. despesa vinculada a pedido não é cancelada por aqui, mesmo que o vínculo tenha surgido depois da leitura');

-- O espelho do Bling (sincronização) segue gravando pelo servidor, no escopo.
with alterados as (
    update public.titulos_financeiros set valor = 310.00
     where id = 'd7000000-0000-4000-8000-000000000073' and organizacao_id = 'd7000000-0000-4000-8000-00000000000b'
    returning 1
)
select is((select count(*)::int from alterados), 1,
          '36. o repositório do servidor (service_role, filtro de organização) grava em titulos_financeiros');

-- Compatibilidade da `main` anterior à fatia 2: as correções de título ainda
-- fazem DELETE/UPDATE direto com service_role, com os mesmos filtros de
-- `FinanceiroRepository`. A 82 não pode quebrá-las.
insert into public.titulos_financeiros (id, organizacao_id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao) values
    ('d7000000-0000-4000-8000-000000000075', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1',
     null, 'pagar', 'pago', 20.00, '2026-11-10', 'Interna paga A'),
    ('d7000000-0000-4000-8000-000000000076', 'd7000000-0000-4000-8000-00000000000a', 'd7000000-0000-4000-8000-0000000000a1',
     7603, 'pagar', 'aberto', 30.00, '2026-11-10', 'Do Bling A');
with removidas as (
    delete from public.titulos_financeiros
     where id = 'd7000000-0000-4000-8000-000000000075' and organizacao_id = 'd7000000-0000-4000-8000-00000000000a'
       and tipo = 'pagar' and bling_id is null and pedido_id is null and situacao in ('aberto', 'pago')
    returning 1
)
select is((select count(*)::int from removidas), 1,
          '37. compatibilidade: a exclusão interna da main anterior (DELETE direto, service_role) segue funcionando');
with canceladas as (
    update public.titulos_financeiros set situacao = 'cancelado'
     where id = 'd7000000-0000-4000-8000-000000000076' and organizacao_id = 'd7000000-0000-4000-8000-00000000000a'
       and tipo = 'pagar' and bling_id is not null and situacao in ('aberto', 'pago')
    returning 1
)
select is((select count(*)::int from canceladas), 1,
          '38. compatibilidade: o cancelamento local da main anterior (UPDATE direto, service_role) segue funcionando');

-- A sonda de disponibilidade da fatia 2: chamar com argumentos nulos recusa
-- com 22023 antes de qualquer leitura ou escrita.
select throws_ok(
    $$select public.cancelar_despesa_local_auditada(null, null, null, null, null)$$,
    '22023', 'Organizacao, ator e titulo sao obrigatorios.',
    '39. sonda: argumentos nulos são recusados com 22023, sem efeito');

reset role;

select * from finish();
rollback;
