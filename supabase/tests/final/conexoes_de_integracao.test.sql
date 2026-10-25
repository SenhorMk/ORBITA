-- conexoes_de_integracao.test.sql
-- PRE-008, contra o schema canônico completo (migration 84).
--
-- Nenhum token de navegador — owner, admin ou member, da organização ou de
-- outra, nem quem é membro de duas — escreve direto em conexoes_integracao,
-- chatwoot_inboxes, credenciais_integracao ou integracoes_bling: não reativa
-- conexão, não troca client_id, não move a conexão para outra organização, não
-- apaga, não reivindica inbox alheia, não lê nem grava segredo. A leitura sob
-- RLS continua por membership. Do lado do servidor (`service_role`), a
-- organização de conexão, credencial e inbox não muda, e o inbox só aponta para
-- conexão Chatwoot da mesma organização.
--
-- REINTRODUZIR O DEFEITO (laboratório, contraprovas do PRE-008):
--   grant update on public.conexoes_integracao to authenticated         → 1-7, 15
--   grant insert, delete on public.conexoes_integracao to authenticated → 1-4, 8, 9, 15
--   grant insert on public.chatwoot_inboxes to authenticated            → 1-4, 11, 15
--   grant select on public.credenciais_integracao to authenticated      → 12
--   grant execute on atualizar_saude_conexao to authenticated           → 18
--   recriar uma policy FOR ALL por membership (a da migration 25)       → 16, 17, 34
--   drop trigger trg_organizacao_da_conexao_imutavel                    → 24
--   drop trigger trg_valida_conexao_do_chatwoot_inbox                   → 27, 28

begin;

select plan(35);

-- ----------------------------------------------------------------------------
-- Duas organizações. Em A: owner, admin, member. Em B: owner. `d1` é member
-- das duas (o caso do WITH CHECK antigo). Conexões: Chatwoot e Bling em A,
-- Chatwoot em B; credencial e inbox na conexão Chatwoot de A.
-- ----------------------------------------------------------------------------
insert into auth.users (id, email) values
    ('d8000000-0000-4000-8000-0000000000a1', 'dono-a-p8@orbita.test'),
    ('d8000000-0000-4000-8000-0000000000a2', 'admin-a-p8@orbita.test'),
    ('d8000000-0000-4000-8000-0000000000a3', 'membro-a-p8@orbita.test'),
    ('d8000000-0000-4000-8000-0000000000b1', 'dono-b-p8@orbita.test'),
    ('d8000000-0000-4000-8000-0000000000d1', 'duplo-p8@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('d8000000-0000-4000-8000-00000000000a', 'Org A P8', 'org-a-p8', 'active'),
    ('d8000000-0000-4000-8000-00000000000b', 'Org B P8', 'org-b-p8', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('d8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-0000000000a1', 'owner'),
    ('d8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-0000000000a2', 'admin'),
    ('d8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-0000000000a3', 'member'),
    ('d8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-0000000000d1', 'member'),
    ('d8000000-0000-4000-8000-00000000000b', 'd8000000-0000-4000-8000-0000000000b1', 'owner'),
    ('d8000000-0000-4000-8000-00000000000b', 'd8000000-0000-4000-8000-0000000000d1', 'member');

insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status, metadata) values
    ('d8000000-0000-4000-8000-0000000000c1', 'd8000000-0000-4000-8000-00000000000a', 'chatwoot', 'Principal', 'conectado', '{}'),
    ('d8000000-0000-4000-8000-0000000000c2', 'd8000000-0000-4000-8000-00000000000a', 'bling', 'Principal', 'desconectado',
     '{"client_id": "client-id-sintetico-a"}'),
    ('d8000000-0000-4000-8000-0000000000c3', 'd8000000-0000-4000-8000-00000000000b', 'chatwoot', 'Principal', 'conectado', '{}');
insert into public.credenciais_integracao (conexao_id, organizacao_id, dados_cifrados) values
    ('d8000000-0000-4000-8000-0000000000c1', 'd8000000-0000-4000-8000-00000000000a', 'iv:tag:cifra-sintetica-a');
insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id, user_id) values
    ('d8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-0000000000c1', 1, '7', 'd8000000-0000-4000-8000-0000000000a1');

-- Retrato das quatro tabelas, para provar que nenhuma tentativa mudou nada.
create temp table retrato_antes as
select (select md5(coalesce(string_agg(c::text, '|' order by c.id), '')) from public.conexoes_integracao c) as conexoes,
       (select md5(coalesce(string_agg(i::text, '|' order by i.id), '')) from public.chatwoot_inboxes i) as inboxes,
       (select md5(coalesce(string_agg(k::text, '|' order by k.id), '')) from public.credenciais_integracao k) as credenciais;

-- Tenta INSERT, UPDATE, DELETE e TRUNCATE. Só a recusa de privilégio **na
-- própria tabela** conta como negação: a RLS responde o mesmo SQLSTATE (42501)
-- e significaria que o grant passou.
create temp table tentativa_de_escrita (tabela text, sql text);
insert into tentativa_de_escrita values
    ('conexoes_integracao', 'insert into public.conexoes_integracao (organizacao_id, provedor) values (''d8000000-0000-4000-8000-00000000000a'', ''custom'')'),
    ('conexoes_integracao', 'update public.conexoes_integracao set status = status'),
    ('conexoes_integracao', 'delete from public.conexoes_integracao'),
    ('conexoes_integracao', 'truncate public.conexoes_integracao cascade'),
    ('chatwoot_inboxes', 'insert into public.chatwoot_inboxes (organizacao_id, inbox_id) values (''d8000000-0000-4000-8000-00000000000a'', 99)'),
    ('chatwoot_inboxes', 'update public.chatwoot_inboxes set inbox_id = inbox_id'),
    ('chatwoot_inboxes', 'delete from public.chatwoot_inboxes'),
    ('chatwoot_inboxes', 'truncate public.chatwoot_inboxes'),
    ('credenciais_integracao', 'update public.credenciais_integracao set dados_cifrados = ''x'''),
    ('integracoes_bling', 'update public.integracoes_bling set access_token = ''x''');
grant select on tentativa_de_escrita to authenticated, anon;

create function pg_temp.escritas_que_passaram() returns text[] language plpgsql as $f$
declare v_t record; v_passou text[] := '{}';
begin
    for v_t in select tabela, sql from pg_temp.tentativa_de_escrita loop
        begin
            execute v_t.sql;
            v_passou := v_passou || v_t.sql;
        exception when insufficient_privilege then
            if sqlerrm <> 'permission denied for table ' || v_t.tabela then
                v_passou := v_passou || (v_t.sql || ' [' || sqlerrm || ']');
            end if;
        end;
    end loop;
    return v_passou;
end $f$;
grant execute on function pg_temp.escritas_que_passaram() to authenticated, anon;

-- ----------------------------------------------------------------------------
-- 1-4. Nenhum JWT de navegador escreve nas quatro tabelas.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';

set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000a1';
select is(pg_temp.escritas_que_passaram(), '{}'::text[], '1. owner de A não escreve em nenhuma tabela de integração');
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000a2';
select is(pg_temp.escritas_que_passaram(), '{}'::text[], '2. admin de A também não');
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000a3';
select is(pg_temp.escritas_que_passaram(), '{}'::text[], '3. member de A (sem organization:manage) também não');
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000b1';
select is(pg_temp.escritas_que_passaram(), '{}'::text[], '4. owner de B também não');

-- ----------------------------------------------------------------------------
-- 5-11. Os ataques do ticket, um a um.
-- ----------------------------------------------------------------------------
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000a3';
select throws_ok(
    $$update public.conexoes_integracao set status = 'conectado' where id = 'd8000000-0000-4000-8000-0000000000c2'$$,
    '42501', 'permission denied for table conexoes_integracao', '5. member não reativa a conexão desligada pela Data API');
select throws_ok(
    $$update public.conexoes_integracao set metadata = '{"client_id": "app-do-atacante"}' where id = 'd8000000-0000-4000-8000-0000000000c2'$$,
    '42501', 'permission denied for table conexoes_integracao', '6. member não troca o client_id que o authorize lê');
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000d1';
select throws_ok(
    $$update public.conexoes_integracao set organizacao_id = 'd8000000-0000-4000-8000-00000000000b' where id = 'd8000000-0000-4000-8000-0000000000c1'$$,
    '42501', 'permission denied for table conexoes_integracao', '7. membro de A e de B não move a conexão de A para B');
select throws_ok(
    $$delete from public.conexoes_integracao where id = 'd8000000-0000-4000-8000-0000000000c1'$$,
    '42501', 'permission denied for table conexoes_integracao', '8. nem apaga a conexão (e, em cascata, a credencial)');
select throws_ok(
    $$insert into public.conexoes_integracao (organizacao_id, provedor, nome, status) values ('d8000000-0000-4000-8000-00000000000b', 'chatwoot', 'Paralela', 'conectado')$$,
    '42501', 'permission denied for table conexoes_integracao', '9. nem cria conexão "conectado" sem passar pela API');
select throws_ok(
    $$update public.chatwoot_inboxes set organizacao_id = 'd8000000-0000-4000-8000-00000000000b'$$,
    '42501', 'permission denied for table chatwoot_inboxes', '10. nem move o mapeamento de inbox de A para B');
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000b1';
select throws_ok(
    $$insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id) values ('d8000000-0000-4000-8000-00000000000b', 'd8000000-0000-4000-8000-0000000000c1', 1, '7')$$,
    '42501', 'permission denied for table chatwoot_inboxes', '11. owner de B não reivindica a inbox de A');

-- ----------------------------------------------------------------------------
-- 12-13. Segredo: o navegador não lê nem grava credencial.
-- ----------------------------------------------------------------------------
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000a1';
select throws_ok($$select dados_cifrados from public.credenciais_integracao$$,
    '42501', 'permission denied for table credenciais_integracao', '12. owner de A não lê a credencial cifrada');
select throws_ok($$select access_token from public.integracoes_bling$$,
    '42501', 'permission denied for table integracoes_bling', '13. nem o espelho legado com tokens');

-- ----------------------------------------------------------------------------
-- 14-18. O catálogo concede o que a matriz diz.
-- ----------------------------------------------------------------------------
reset role;

select is(
    (select count(*) from unnest(array['public.conexoes_integracao', 'public.chatwoot_inboxes',
                                       'public.credenciais_integracao', 'public.integracoes_bling']) t,
                          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      where has_table_privilege('anon', t, p)),
    0::bigint, '14. anon não tem privilégio nenhum nas quatro tabelas');
select is(
    (select count(*) from pg_attribute a, unnest(array['authenticated', 'anon']) papel
      where a.attrelid in ('public.conexoes_integracao'::regclass, 'public.chatwoot_inboxes'::regclass,
                           'public.credenciais_integracao'::regclass, 'public.integracoes_bling'::regclass)
        and a.attnum > 0 and not a.attisdropped
        and (has_column_privilege(papel, a.attrelid, a.attname, 'INSERT')
             or has_column_privilege(papel, a.attrelid, a.attname, 'UPDATE'))),
    0::bigint, '15. nenhuma coluna gravável pelo navegador, nem por grant de coluna');
select is(
    (select array_agg(p.polrelid::regclass::text || ':' || p.polname || ':' || p.polcmd::text order by p.polname)
       from pg_policy p
      where p.polrelid in ('public.conexoes_integracao'::regclass, 'public.chatwoot_inboxes'::regclass,
                           'public.credenciais_integracao'::regclass)
        and (p.polroles = array['authenticated'::regrole]::oid[])
        and coalesce(pg_get_expr(p.polqual, p.polrelid), '') !~ 'auth\.uid'),
    array['chatwoot_inboxes:chatwoot_inboxes_org_select:r', 'conexoes_integracao:conexoes_integracao_org_select:r'],
    '16. as únicas policies são de leitura por membership, sem auth.uid() e sem escrita');
select is(
    (select count(*) from pg_policy p
      where p.polrelid in ('public.conexoes_integracao'::regclass, 'public.chatwoot_inboxes'::regclass,
                           'public.credenciais_integracao'::regclass)),
    2::bigint, '17. e não sobrou nenhuma outra');
select is(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosrc ~ '\m(conexoes_integracao|credenciais_integracao|chatwoot_inboxes|integracoes_bling)\M'
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
    0::bigint, '18. o navegador não executa nenhuma função que toque as tabelas de integração');

select ok(
    (select r.conexoes = (select md5(coalesce(string_agg(c::text, '|' order by c.id), '')) from public.conexoes_integracao c)
        and r.inboxes = (select md5(coalesce(string_agg(i::text, '|' order by i.id), '')) from public.chatwoot_inboxes i)
        and r.credenciais = (select md5(coalesce(string_agg(k::text, '|' order by k.id), '')) from public.credenciais_integracao k)
       from retrato_antes r),
    '19. nenhuma tentativa mudou conexão, inbox ou credencial (hash idêntico)');

-- ----------------------------------------------------------------------------
-- 20-22. Leitura conforme a membership.
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000a3';
select is((select count(*) from public.conexoes_integracao where id::text like 'd8000000-%'), 2::bigint,
    '20. member de A lê as duas conexões de A');
select is((select count(*) from public.conexoes_integracao where organizacao_id = 'd8000000-0000-4000-8000-00000000000b'), 0::bigint,
    '21. e nenhuma de B');
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000b1';
select is((select count(*) from public.chatwoot_inboxes where organizacao_id = 'd8000000-0000-4000-8000-00000000000a'), 0::bigint,
    '22. owner de B não lê o mapeamento de inbox de A');
reset role;

-- ----------------------------------------------------------------------------
-- 23-31. Servidor (`service_role`): o fluxo legítimo continua; organização
-- imutável; inbox só na conexão Chatwoot da mesma organização; entrada
-- inválida recusada.
-- ----------------------------------------------------------------------------
set local role service_role;

select lives_ok(
    $$update public.conexoes_integracao set status = 'pendente', metadata = '{"client_id": "client-id-novo"}'
       where id = 'd8000000-0000-4000-8000-0000000000c2' and organizacao_id = 'd8000000-0000-4000-8000-00000000000a';
      insert into public.credenciais_integracao (conexao_id, organizacao_id, dados_cifrados)
      values ('d8000000-0000-4000-8000-0000000000c2', 'd8000000-0000-4000-8000-00000000000a', 'iv:tag:cifra-bling')
      on conflict (conexao_id) do update set dados_cifrados = excluded.dados_cifrados;
      update public.conexoes_integracao set status = 'conectado'
       where id = 'd8000000-0000-4000-8000-0000000000c2' and organizacao_id = 'd8000000-0000-4000-8000-00000000000a'$$,
    '23. a reconexão pela API (connect → cofre → callback) continua funcionando');
select throws_ok(
    $$update public.conexoes_integracao set organizacao_id = 'd8000000-0000-4000-8000-00000000000b' where id = 'd8000000-0000-4000-8000-0000000000c1'$$,
    '23514', 'A organizacao de public.conexoes_integracao nao muda depois de definida.',
    '24. nem o servidor move uma conexão para outra organização');
select throws_ok(
    $$update public.credenciais_integracao set organizacao_id = 'd8000000-0000-4000-8000-00000000000b',
                                                conexao_id = 'd8000000-0000-4000-8000-0000000000c3'
       where conexao_id = 'd8000000-0000-4000-8000-0000000000c1'$$,
    '23514', 'A organizacao de public.credenciais_integracao nao muda depois de definida.',
    '25. nem uma credencial, mesmo trocando a conexão junto');
select throws_ok(
    $$update public.chatwoot_inboxes set organizacao_id = 'd8000000-0000-4000-8000-00000000000b' where inbox_id = 1
       and organizacao_id = 'd8000000-0000-4000-8000-00000000000a'$$,
    '23514', 'A organizacao de public.chatwoot_inboxes nao muda depois de definida.',
    '26. nem um mapeamento de inbox');
select throws_ok(
    $$insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id, user_id)
      values ('d8000000-0000-4000-8000-00000000000b', 'd8000000-0000-4000-8000-0000000000c1', 1, '7', 'd8000000-0000-4000-8000-0000000000b1')$$,
    '23503', 'Inbox Chatwoot so mapeia para conexao Chatwoot da mesma organizacao.',
    '27. inbox de B apontando para a conexão de A é recusada (claim de inbox alheia)');
select throws_ok(
    $$insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, user_id)
      values ('d8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-0000000000c2', 2, 'd8000000-0000-4000-8000-0000000000a1')$$,
    '23503', 'Inbox Chatwoot so mapeia para conexao Chatwoot da mesma organizacao.',
    '28. inbox apontando para a conexão Bling é recusada');
select lives_ok(
    $$insert into public.chatwoot_inboxes (organizacao_id, conexao_id, inbox_id, account_id, user_id)
      values ('d8000000-0000-4000-8000-00000000000b', 'd8000000-0000-4000-8000-0000000000c3', 1, '7', 'd8000000-0000-4000-8000-0000000000b1')$$,
    '29. B mapeia o próprio inbox 1 na própria conexão, sem colidir com o inbox 1 de A');
select throws_ok(
    $$update public.conexoes_integracao set status = 'revogada' where id = 'd8000000-0000-4000-8000-0000000000c1'$$,
    '23514', null, '30. status fora do contrato é recusado');
select throws_ok(
    $$insert into public.credenciais_integracao (conexao_id, organizacao_id, dados_cifrados)
      values ('d8000000-0000-4000-8000-0000000000c3', 'd8000000-0000-4000-8000-00000000000a', 'iv:tag:x')$$,
    '23503', 'Credencial pertence a organizacao diferente da conexao',
    '31. credencial de A gravada na conexão de B é recusada');

-- ----------------------------------------------------------------------------
-- 32-33. Desligar a conexão (contenção do runbook) preserva mapping e
-- credencial; apagá-la solta o inbox (`set null`) sem violar a validação.
-- ----------------------------------------------------------------------------
select lives_ok(
    $$update public.conexoes_integracao set status = 'desconectado' where id = 'd8000000-0000-4000-8000-0000000000c1'$$,
    '32. o servidor pausa a conexão');
select is(
    (select count(*) from public.chatwoot_inboxes where conexao_id = 'd8000000-0000-4000-8000-0000000000c1')
      + (select count(*) from public.credenciais_integracao where conexao_id = 'd8000000-0000-4000-8000-0000000000c1'),
    2::bigint, '33. pausada, a conexão conserva o mapping e a credencial');
reset role;

-- ----------------------------------------------------------------------------
-- 34. Segunda barreira: mesmo com o UPDATE de volta por engano, sem policy de
-- escrita a RLS não deixa o member tocar nenhuma linha.
-- ----------------------------------------------------------------------------
grant update on public.conexoes_integracao to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = 'd8000000-0000-4000-8000-0000000000a3';
update public.conexoes_integracao set status = 'conectado' where id = 'd8000000-0000-4000-8000-0000000000c1';
reset role;
select is((select status from public.conexoes_integracao where id = 'd8000000-0000-4000-8000-0000000000c1'), 'desconectado',
    '34. com o grant de volta, o UPDATE do member não alcança nenhuma linha');
revoke update on public.conexoes_integracao from authenticated;

set local role service_role;
select lives_ok(
    $$delete from public.conexoes_integracao where id = 'd8000000-0000-4000-8000-0000000000c1'$$,
    '35. apagar a conexão pelo servidor solta o inbox (on delete set null) sem violar a validação');
reset role;

select * from finish();
rollback;
