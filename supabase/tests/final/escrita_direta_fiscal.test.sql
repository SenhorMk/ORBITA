-- escrita_direta_fiscal.test.sql
-- PRE-007B, contra o schema canônico completo (migration 83).
--
-- Nenhum token de navegador — owner, admin ou member, da organização ou de
-- outra — escreve direto em documentos_fiscais: não forja NF-e emitida, não
-- troca número, chave ou situação, não apaga nota. A leitura sob RLS continua
-- por membership. O registro da NF-e emitida (`registrar_documento_fiscal_emitido`)
-- grava o documento e o evento na mesma transação: se a auditoria falha, nada
-- muda.
--
-- REINTRODUZIR O DEFEITO (laboratório, contraprovas do PRE-007B):
--   grant insert on public.documentos_fiscais to authenticated              → 1-4, 8, 9, 12, 19
--   grant update (status) on public.documentos_fiscais to authenticated     → 5, 6, 8, 12
--   grant delete on public.documentos_fiscais to anon                       → 7, 10
--   grant execute on registrar_documento_fiscal_emitido to authenticated    → 16, 22
--   registrar sem a chamada de auditoria                                    → 23, 24, 30, 32
--   recriar a policy legada `organização OR user_id = auth.uid()`           → 14

begin;

select plan(34);

-- ----------------------------------------------------------------------------
-- Duas organizações; em A, owner, admin e member. Uma NF-e em cada uma.
-- ----------------------------------------------------------------------------
insert into auth.users (id, email) values
    ('d7b00000-0000-4000-8000-0000000000a1', 'dono-a-t7b@orbita.test'),
    ('d7b00000-0000-4000-8000-0000000000a2', 'admin-a-t7b@orbita.test'),
    ('d7b00000-0000-4000-8000-0000000000a3', 'membro-a-t7b@orbita.test'),
    ('d7b00000-0000-4000-8000-0000000000b1', 'dono-b-t7b@orbita.test'),
    ('d7b00000-0000-4000-8000-0000000000c1', 'de-fora-t7b@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('d7b00000-0000-4000-8000-00000000000a', 'Org A T7B', 'org-a-t7b', 'active'),
    ('d7b00000-0000-4000-8000-00000000000b', 'Org B T7B', 'org-b-t7b', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('d7b00000-0000-4000-8000-00000000000a', 'd7b00000-0000-4000-8000-0000000000a1', 'owner'),
    ('d7b00000-0000-4000-8000-00000000000a', 'd7b00000-0000-4000-8000-0000000000a2', 'admin'),
    ('d7b00000-0000-4000-8000-00000000000a', 'd7b00000-0000-4000-8000-0000000000a3', 'member'),
    ('d7b00000-0000-4000-8000-00000000000b', 'd7b00000-0000-4000-8000-0000000000b1', 'owner');

insert into public.clientes (id, organizacao_id, user_id, bling_id, nome) values
    ('d7b00000-0000-4000-8000-0000000000ca', 'd7b00000-0000-4000-8000-00000000000a', 'd7b00000-0000-4000-8000-0000000000a1', '7b01', 'Cliente A'),
    ('d7b00000-0000-4000-8000-0000000000cb', 'd7b00000-0000-4000-8000-00000000000b', 'd7b00000-0000-4000-8000-0000000000b1', '7b02', 'Cliente B');
-- Em A: um pedido já faturado (e1) e um a faturar (e2). Em B: um faturado (e3).
insert into public.pedidos (id, organizacao_id, user_id, cliente_id, bling_id, numero, data, total, status, origem) values
    ('d7b00000-0000-4000-8000-0000000000e1', 'd7b00000-0000-4000-8000-00000000000a', 'd7b00000-0000-4000-8000-0000000000a1',
     'd7b00000-0000-4000-8000-0000000000ca', '7b11', '7b11', now(), 10, 'Atendido', 'Bling'),
    ('d7b00000-0000-4000-8000-0000000000e2', 'd7b00000-0000-4000-8000-00000000000a', 'd7b00000-0000-4000-8000-0000000000a1',
     'd7b00000-0000-4000-8000-0000000000ca', '7b12', '7b12', now(), 20, 'Pendente', 'Bling'),
    ('d7b00000-0000-4000-8000-0000000000e3', 'd7b00000-0000-4000-8000-00000000000b', 'd7b00000-0000-4000-8000-0000000000b1',
     'd7b00000-0000-4000-8000-0000000000cb', '7b13', '7b13', now(), 30, 'Atendido', 'Bling');
insert into public.documentos_fiscais (id, organizacao_id, user_id, pedido_id, bling_id, numero, chave_acesso, status) values
    ('d7b00000-0000-4000-8000-0000000000f1', 'd7b00000-0000-4000-8000-00000000000a', 'd7b00000-0000-4000-8000-0000000000a1',
     'd7b00000-0000-4000-8000-0000000000e1', 'nfe-7b-1', '1001', 'chave-sintetica-a', 'Emitida'),
    ('d7b00000-0000-4000-8000-0000000000f3', 'd7b00000-0000-4000-8000-00000000000b', 'd7b00000-0000-4000-8000-0000000000b1',
     'd7b00000-0000-4000-8000-0000000000e3', 'nfe-7b-3', '3001', 'chave-sintetica-b', 'Emitida');

-- Retrato da tabela, para provar que nenhuma tentativa mudou nada.
create temp table retrato_antes as
select md5(string_agg(d::text, '|' order by d.id)) as hash from public.documentos_fiscais d;

-- Tenta INSERT, UPDATE, DELETE e TRUNCATE. Só a recusa de privilégio **na
-- própria tabela** conta como negação: a RLS responde o mesmo SQLSTATE (42501)
-- e significaria que o grant passou.
create temp table tentativa_de_escrita (sql text);
insert into tentativa_de_escrita values
    ('insert into public.documentos_fiscais default values'),
    ('update public.documentos_fiscais set id = id'),
    ('delete from public.documentos_fiscais'),
    ('truncate public.documentos_fiscais');
grant select on tentativa_de_escrita to authenticated, anon;

-- ----------------------------------------------------------------------------
-- 1-6. Nenhum JWT de navegador escreve: owner, admin e member de A; owner de B.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';

set local request.jwt.claim.sub = 'd7b00000-0000-4000-8000-0000000000a1';
select lives_ok($t$ do $d$
    declare v_sql text; v_passou text[] := '{}';
    begin
        for v_sql in select sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                if sqlerrm <> 'permission denied for table documentos_fiscais' then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '1. owner de A não executa INSERT, UPDATE, DELETE nem TRUNCATE em documentos_fiscais');

set local request.jwt.claim.sub = 'd7b00000-0000-4000-8000-0000000000a2';
select lives_ok($t$ do $d$
    declare v_sql text; v_passou text[] := '{}';
    begin
        for v_sql in select sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                if sqlerrm <> 'permission denied for table documentos_fiscais' then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '2. admin de A também não');

set local request.jwt.claim.sub = 'd7b00000-0000-4000-8000-0000000000a3';
select lives_ok($t$ do $d$
    declare v_sql text; v_passou text[] := '{}';
    begin
        for v_sql in select sql from pg_temp.tentativa_de_escrita loop
            begin
                execute v_sql;
                v_passou := v_passou || v_sql;
            exception when insufficient_privilege then
                if sqlerrm <> 'permission denied for table documentos_fiscais' then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '3. member de A (sem organization:manage) também não');

select throws_ok(
    $$insert into public.documentos_fiscais (organizacao_id, user_id, pedido_id, bling_id, numero, status)
      values ('d7b00000-0000-4000-8000-00000000000a', 'd7b00000-0000-4000-8000-0000000000a3',
              'd7b00000-0000-4000-8000-0000000000e2', 'forjada', '9999', 'Emitida')$$,
    '42501', 'permission denied for table documentos_fiscais', '4. member não forja NF-e emitida para um pedido da própria organização');
select throws_ok(
    $$update public.documentos_fiscais set status = 'Cancelada'
       where id = 'd7b00000-0000-4000-8000-0000000000f1'$$,
    '42501', 'permission denied for table documentos_fiscais', '5. member não cancela uma nota da própria organização');

set local request.jwt.claim.sub = 'd7b00000-0000-4000-8000-0000000000b1';
select throws_ok(
    $$update public.documentos_fiscais set status = 'Cancelada'
       where organizacao_id = 'd7b00000-0000-4000-8000-00000000000a'$$,
    '42501', 'permission denied for table documentos_fiscais', '6. owner de B não altera notas de A');

reset role;

-- ----------------------------------------------------------------------------
-- 7-8. anon também não, e nada mudou.
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
                if sqlerrm <> 'permission denied for table documentos_fiscais' then v_passou := v_passou || (v_sql || ' [' || sqlerrm || ']'); end if;
            end;
        end loop;
        if cardinality(v_passou) > 0 then raise exception 'escreveu direto: %', v_passou; end if;
    end $d$ $t$, '7. anon não executa nenhuma escrita em documentos_fiscais');
reset role;

select is(
    (select md5(string_agg(d::text, '|' order by d.id)) from public.documentos_fiscais d),
    (select hash from retrato_antes),
    '8. depois de todas as tentativas, documentos_fiscais está idêntica');

-- ----------------------------------------------------------------------------
-- 9-13. Matriz de privilégios efetivos (não só os grants visíveis).
-- ----------------------------------------------------------------------------
select is(
    (select string_agg(p, ',' order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      where has_table_privilege('authenticated', 'public.documentos_fiscais', p)),
    'SELECT', '9. authenticated: só SELECT em documentos_fiscais (o DML foi revogado no PRE-007B)');
select is(
    (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      where has_table_privilege('anon', 'public.documentos_fiscais', p)),
    0, '10. anon: nenhum privilégio em documentos_fiscais');
select is(
    (select count(*)::int from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where c.oid = 'public.documentos_fiscais'::regclass and a.grantee = 0),
    0, '11. PUBLIC: nenhuma entrada de ACL em documentos_fiscais');
select is(
    (select count(*)::int from pg_attribute a cross join (values ('authenticated'), ('anon')) r(papel)
      where a.attrelid = 'public.documentos_fiscais'::regclass and a.attnum > 0 and not a.attisdropped
        and (has_column_privilege(r.papel, a.attrelid, a.attname, 'INSERT')
             or has_column_privilege(r.papel, a.attrelid, a.attname, 'UPDATE'))),
    0, '12. nenhuma coluna é gravável por authenticated ou anon (nem status, nem numero, nem chave_acesso)');
select is(
    (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
      where not has_table_privilege('service_role', 'public.documentos_fiscais', p)),
    0, '13. service_role mantém SELECT, INSERT, UPDATE e DELETE (comandos do servidor)');

-- ----------------------------------------------------------------------------
-- 14-18. Policies, RLS, RPCs e Realtime.
-- ----------------------------------------------------------------------------
select is(
    (select count(*)::int from pg_policy p
      where p.polrelid = 'public.documentos_fiscais'::regclass
        and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'auth\.uid'
             or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'auth\.uid'
             or not (p.polroles = array['authenticated'::regrole]::oid[]))),
    0, '14. toda policy de documentos_fiscais é de authenticated e isola só por organização (sem ramo auth.uid())');
select ok(
    (select relrowsecurity from pg_class where oid = 'public.documentos_fiscais'::regclass),
    '15. RLS ligada em documentos_fiscais');

-- Funções de extensão (pgTAP em `public`, por exemplo) não são RPC do produto.
create temp table funcoes_do_produto as
select p.oid, p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');

create temp table funcoes_que_escrevem as
select p.oid, p.proname from funcoes_do_produto p
 where p.prosrc ~* '(insert\s+into|update|delete\s+from|truncate)\s+(public\.)?documentos_fiscais\M';

select is(
    (select count(*)::int from funcoes_que_escrevem f
      where has_function_privilege('authenticated', f.oid, 'execute') or has_function_privilege('anon', f.oid, 'execute')),
    0, '16. nenhuma RPC executável pelo navegador escreve em documentos_fiscais');
select is(
    (select count(*)::int from funcoes_do_produto p
      where (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
        and (exists (select 1 from funcoes_que_escrevem f where f.oid <> p.oid and p.prosrc ~* ('\m' || f.proname || '\s*\('))
             or p.prosrc ~* '\mexecute\s+(format|''|[a-z_]+\s*(\|\||;|using))')),
    0, '17. nem indiretamente: nenhuma delas chama função que escreve, nem monta SQL dinâmico');
select is(
    (select count(*)::int from pg_publication_tables pt
      where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public' and pt.tablename = 'documentos_fiscais'),
    0, '18. documentos_fiscais não é publicada no Realtime');

-- ----------------------------------------------------------------------------
-- 19-22. A leitura continua conforme a membership; o navegador não chama a RPC.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'd7b00000-0000-4000-8000-0000000000a3';

select is(
    (select string_agg(numero, ',' order by numero) from public.documentos_fiscais),
    '1001', '19. member de A lê as notas da própria organização');
select is(
    (select count(*)::int from public.documentos_fiscais where organizacao_id = 'd7b00000-0000-4000-8000-00000000000b'),
    0, '20. e não lê nada de B');

set local request.jwt.claim.sub = 'd7b00000-0000-4000-8000-0000000000c1';
select is((select count(*)::int from public.documentos_fiscais), 0, '21. quem não é membro não lê nada');

set local request.jwt.claim.sub = 'd7b00000-0000-4000-8000-0000000000a1';
select throws_ok(
    $$select public.registrar_documento_fiscal_emitido('d7b00000-0000-4000-8000-00000000000a',
        'd7b00000-0000-4000-8000-0000000000a1', 'd7b00000-0000-4000-8000-0000000000e2',
        'forjada', '9999', null, 'Emitida', 'corr_t7b')$$,
    '42501', 'permission denied for function registrar_documento_fiscal_emitido',
    '22. o owner não registra nota chamando a RPC do servidor');
reset role;

-- ----------------------------------------------------------------------------
-- 23-34. Comando do servidor: escopo da organização e auditoria obrigatória.
-- ----------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claim.role = 'service_role';

-- Ator sem membership: `registrar_evento_auditoria` recusa o evento, e o
-- INSERT da mesma transação é desfeito.
select throws_like(
    $$select public.registrar_documento_fiscal_emitido('d7b00000-0000-4000-8000-00000000000a',
        'd7b00000-0000-4000-8000-0000000000c1', 'd7b00000-0000-4000-8000-0000000000e2',
        'nfe-7b-2', '1002', 'chave-sintetica-a2', 'Emitida', 'corr_t7b_falha')$$,
    '%evento de auditoria recusado (anti-forjamento cross-tenant)%', '23. auditoria recusada: o registro da nota falha');
select is(
    (select count(*)::int from public.documentos_fiscais where bling_id = 'nfe-7b-2')
      || ':' || (select count(*)::int from public.eventos_auditoria_sistema where correlation_id = 'corr_t7b_falha'),
    '0:0', '24. e não ficou nota nem evento: a falha da auditoria abortou a mutação');

select throws_ok(
    $$select public.registrar_documento_fiscal_emitido('d7b00000-0000-4000-8000-00000000000b',
        'd7b00000-0000-4000-8000-0000000000b1', 'd7b00000-0000-4000-8000-0000000000e2',
        'nfe-7b-x', '9001', null, 'Emitida', 'corr_t7b_cruzado')$$,
    '23503', null, '25. a organização B não registra nota para um pedido de A, mesmo com service_role');

select throws_ok(
    $$select public.registrar_documento_fiscal_emitido('d7b00000-0000-4000-8000-00000000000a',
        'd7b00000-0000-4000-8000-0000000000a1', null, 'nfe-7b-2', '1002', null, 'Emitida', 'corr_t7b_inv')$$,
    '22023', 'Organizacao, ator e pedido sao obrigatorios.', '26. entrada inválida: sem pedido é recusada');
select throws_ok(
    $$select public.registrar_documento_fiscal_emitido('d7b00000-0000-4000-8000-00000000000a',
        'd7b00000-0000-4000-8000-0000000000a1', 'd7b00000-0000-4000-8000-0000000000e2', 'nfe-7b-2', '  ', null, 'Emitida', 'corr_t7b_inv')$$,
    '22023', 'Identificador e numero da nota sao obrigatorios.', '27. entrada inválida: número em branco é recusado');
select throws_ok(
    $$select public.registrar_documento_fiscal_emitido('d7b00000-0000-4000-8000-00000000000a',
        'd7b00000-0000-4000-8000-0000000000a1', 'd7b00000-0000-4000-8000-0000000000e2', 'nfe-7b-2', '1002', null, 'Qualquer', 'corr_t7b_inv')$$,
    '23514', null, '28. entrada inválida: situação fora do contrato é recusada pela constraint');

select is(
    (public.registrar_documento_fiscal_emitido('d7b00000-0000-4000-8000-00000000000a',
        'd7b00000-0000-4000-8000-0000000000a2', 'd7b00000-0000-4000-8000-0000000000e2',
        'nfe-7b-2', '1002', 'chave-sintetica-a2', 'Emitida', 'corr_t7b_ok')).numero,
    '1002', '29. fluxo autorizado: o admin de A registra a NF-e emitida e recebe a linha');
select is(
    (select count(*)::int || '/' || min(organizacao_id::text) || '/' || min(user_id::text) || '/' || min(tipo)
       from public.documentos_fiscais where bling_id = 'nfe-7b-2')
      || ':' || (select string_agg(e.acao || '/' || e.actor_id || '/' || e.recurso || '/' || (e.metadata ->> 'operacao')
                                   || '/' || (e.metadata ->> 'pedido_id') || '/' || (e.metadata ? 'chave_acesso')::text, ',')
                   from public.eventos_auditoria_sistema e
                  where e.organizacao_id = 'd7b00000-0000-4000-8000-00000000000a' and e.correlation_id = 'corr_t7b_ok'),
    '1/d7b00000-0000-4000-8000-00000000000a/d7b00000-0000-4000-8000-0000000000a2/NFE'
      || ':fiscal.document_issued/d7b00000-0000-4000-8000-0000000000a2/documento_fiscal/inserido/d7b00000-0000-4000-8000-0000000000e2/false',
    '30. a nota ficou na organização, com o ator, e o evento foi gravado uma vez, sem a chave de acesso');

-- Requisição repetida com o mesmo identificador do Bling: atualiza a mesma
-- linha, não duplica, e o evento diz que foi atualização.
select is(
    (public.registrar_documento_fiscal_emitido('d7b00000-0000-4000-8000-00000000000a',
        'd7b00000-0000-4000-8000-0000000000a1', 'd7b00000-0000-4000-8000-0000000000e2',
        'nfe-7b-2', '1002', 'chave-sintetica-a2', 'Emitida', 'corr_t7b_replay')).id::text,
    (select id::text from public.documentos_fiscais where bling_id = 'nfe-7b-2'),
    '31. replay: a mesma nota volta, sem linha nova');
select is(
    (select count(*)::int from public.documentos_fiscais where bling_id = 'nfe-7b-2')
      || ':' || (select string_agg(e.metadata ->> 'operacao', ',') from public.eventos_auditoria_sistema e where e.correlation_id = 'corr_t7b_replay'),
    '1:atualizado', '32. continua uma linha, e o evento do replay registra atualização');

-- Compatibilidade da `main` anterior à fatia 2: `pedidoRepository.upsertNfe`
-- faz o upsert direto com service_role. A 83 não pode quebrá-lo.
with gravadas as (
    insert into public.documentos_fiscais (organizacao_id, user_id, pedido_id, bling_id, numero, chave_acesso, status, tipo)
    values ('d7b00000-0000-4000-8000-00000000000b', 'd7b00000-0000-4000-8000-0000000000b1',
            'd7b00000-0000-4000-8000-0000000000e3', 'nfe-7b-3', '3001', 'chave-sintetica-b', 'Emitida', 'NFE')
    on conflict (organizacao_id, bling_id) do update set status = excluded.status
    returning 1
)
select is((select count(*)::int from gravadas), 1,
          '33. compatibilidade: o upsert direto da main anterior (service_role, organização do escopo) segue funcionando');

-- A sonda da fatia 2: chamar com argumentos nulos recusa com 22023 antes de
-- qualquer leitura ou escrita.
select throws_ok(
    $$select public.registrar_documento_fiscal_emitido(null, null, null, null, null, null, null, null)$$,
    '22023', 'Organizacao, ator e pedido sao obrigatorios.',
    '34. sonda: argumentos nulos são recusados com 22023, sem efeito');

reset role;

select * from finish();
rollback;
