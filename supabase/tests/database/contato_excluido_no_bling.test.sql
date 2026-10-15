-- contato_excluido_no_bling.test.sql
-- PRE-005, migration 77: `contact.deleted` do Bling marca o contato como
-- excluído sem apagá-lo nem inventar nome; pedidos continuam legíveis; um
-- update atrasado não o traz de volta; só a reativação explícita traz.
--
-- REINTRODUZIR O DEFEITO: tire o gatilho `tg_contato_excluido_no_bling_nao_volta`:
-- 6-11 falham (o update atrasado recria, renomeia para `Cliente #id` ou
-- reativa). Tire o `if found` da exclusão vigente no registro: a reentrega
-- tenta gravar outra vigente e o teste aborta em 23505. Tire a trava de
-- registro imutável: 15-17 falham (e 19 e 21-24 em cascata). Tire a checagem
-- de papel da reativação: 18 falha (e 19 em cascata). Tire a guarda de data
-- posterior à reativação: 21-23 falham (a exclusão antiga, ou sem data,
-- desfaz a reativação legítima; 24 em cascata).

begin;

create table public.organizacoes (id uuid primary key);
create table public.membros_organizacao (
    organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
    user_id        uuid not null references auth.users(id) on delete cascade,
    papel          text not null
);
create table public.clientes (
    id             uuid primary key default gen_random_uuid(),
    organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
    bling_id       text not null,
    nome           text not null,
    email          text,
    constraint uq_clientes_org_bling unique (organizacao_id, bling_id)
);
create table public.pedidos (
    id         uuid primary key default gen_random_uuid(),
    cliente_id uuid not null references public.clientes(id) on delete restrict,
    numero     text not null
);

\ir ../../../database/77_contato_excluido_no_bling.sql

insert into auth.users (id, email) values
    ('77000000-0000-4000-8000-0000000000f1', 'admin-t77@orbita.test'),
    ('77000000-0000-4000-8000-0000000000f2', 'membro-t77@orbita.test');
insert into public.organizacoes values
    ('77000000-0000-4000-8000-0000000000a1'), ('77000000-0000-4000-8000-0000000000b1'), ('77000000-0000-4000-8000-0000000000c1');
insert into public.membros_organizacao values
    ('77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-0000000000f1', 'admin'),
    ('77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-0000000000f2', 'member');
insert into public.clientes (id, organizacao_id, bling_id, nome, email) values
    ('77000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000a1', '17000000001', 'Maria Real', 'maria@exemplo.test'),
    ('77000000-0000-4000-8000-000000000002', '77000000-0000-4000-8000-0000000000b1', '17000000001', 'Cliente de B', null),
    ('77000000-0000-4000-8000-000000000003', '77000000-0000-4000-8000-0000000000a1', '55555', 'Outro de A', null),
    ('77000000-0000-4000-8000-000000000004', '77000000-0000-4000-8000-0000000000b1', '99999999901', 'Mesmo id em B', null);
insert into public.pedidos (cliente_id, numero) values ('77000000-0000-4000-8000-000000000001', 'PED-77');

select plan(28);

-- ----------------------------------------------------------------------------
-- 1-5. A exclusão no Bling marca e preserva; a reentrega não muda nada.
-- ----------------------------------------------------------------------------
create temp table r1 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', '2026-10-14 10:00:00+00');
select is((select desfecho || '/' || cliente_id from r1), 'registrado/77000000-0000-4000-8000-000000000001',
          '1. contact.deleted registra a exclusão do contato conhecido');
select is((select nome || '/' || email || '/' || excluido_no_bling_em::text from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'Maria Real/maria@exemplo.test/2026-10-14 10:00:00+00', '2. o contato fica, com o nome real, marcado como excluído');
select is((select c.nome from public.pedidos p join public.clientes c on c.id = p.cliente_id where p.numero = 'PED-77'),
          'Maria Real', '3. o pedido histórico continua legível com o contato');

create temp table r2 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', '2026-10-14 11:00:00+00');
select is((select desfecho from r2)
          || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001')
          || '/' || (select excluido_no_bling_em::text from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'ja_registrado/1/2026-10-14 10:00:00+00', '4. a reentrega responde ja_registrado e não reescreve nada');

create temp table r3 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '99999999901', null);
select is((select desfecho from r3) || '/' || (select count(*)::int from public.clientes
                                               where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '99999999901'),
          'registrado_sem_contato/0', '5. id que o ORBITA nunca teve: exclusão registrada, e nenhum contato é criado');

-- ----------------------------------------------------------------------------
-- 6-11. Update atrasado não recria, não renomeia e não reativa.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$insert into public.clientes (organizacao_id, bling_id, nome) values ('77000000-0000-4000-8000-0000000000a1', '99999999901', 'Cliente #99999999901')$$,
    '23514', null, '6. update atrasado não cria o contato que o ORBITA nunca teve');
select throws_ok(
    $$insert into public.clientes (organizacao_id, bling_id, nome) values ('77000000-0000-4000-8000-0000000000a1', '17000000001', 'Cliente #17000000001')
      on conflict (organizacao_id, bling_id) do update set nome = excluded.nome$$,
    '23514', null, '7. nem o upsert do webhook regrava o contato excluído');
select throws_ok(
    $$update public.clientes set bling_id = '99999999901' where id = '77000000-0000-4000-8000-000000000003'$$,
    '23514', null, '8. nem outro contato passa a apontar para o id excluído');
select throws_ok(
    $$update public.clientes set organizacao_id = '77000000-0000-4000-8000-0000000000a1' where id = '77000000-0000-4000-8000-000000000004'$$,
    '23514', null, '9. nem mover para A o contato de B com o id excluído em A');
select throws_ok(
    $$update public.clientes set excluido_no_bling_em = null where id = '77000000-0000-4000-8000-000000000001'$$,
    '23514', null, '10. limpar a marca por gravação direta não reativa');
select is((select nome || '/' || (excluido_no_bling_em is not null) from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'Maria Real/true', '11. nenhum Cliente #id: o contato segue com o nome real e excluído');

-- ----------------------------------------------------------------------------
-- 12-14. O que continua permitido; isolamento A/B.
-- ----------------------------------------------------------------------------
select lives_ok(
    $$update public.clientes set email = null where id = '77000000-0000-4000-8000-000000000001'$$,
    '12. gravar outros dados do contato excluído (ex.: anonimização LGPD) segue');
select is((select excluido_no_bling_em from public.clientes where id = '77000000-0000-4000-8000-000000000002'), null,
          '13. o mesmo bling_id em outra organização não é afetado');
select lives_ok(
    $$insert into public.clientes (organizacao_id, bling_id, nome) values ('77000000-0000-4000-8000-0000000000b1', '17000000002', 'Novo em B')$$,
    '14. a exclusão de A não impede B');

-- ----------------------------------------------------------------------------
-- 15-24. Registro permanente; só a reativação explícita traz de volta; uma
-- exclusão antiga não a desfaz.
-- ----------------------------------------------------------------------------
select throws_ok($$update public.contatos_excluidos_no_bling set excluido_no_bling_em = now()$$, '23514', null,
                 '15. a exclusão não é reescrita');
select throws_ok($$delete from public.contatos_excluidos_no_bling$$, '23514', null, '16. nem apagada');
select throws_ok(
    $$update public.contatos_excluidos_no_bling set reativado_em = now(), reativado_por = '77000000-0000-4000-8000-0000000000f1'
       where bling_id = '17000000001'$$,
    '23514', null, '17. nem encerrada por gravação direta, fora do comando de reativação');
select throws_ok(
    $$select * from public.reativar_contato_excluido_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000001', '77000000-0000-4000-8000-0000000000f2')$$,
    '42501', null, '18. quem não administra a organização não reativa');

create temp table r4 as select * from public.reativar_contato_excluido_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', '77000000-0000-4000-8000-0000000000f1');
select is((select desfecho from r4)
          || '/' || (select (excluido_no_bling_em is null) from public.clientes where id = '77000000-0000-4000-8000-000000000001')
          || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '17000000001' and reativado_por = '77000000-0000-4000-8000-0000000000f1'),
          'reativado/true/1', '19. a reativação explícita traz o contato de volta e registra quem reativou');
select lives_ok(
    $$insert into public.clientes (organizacao_id, bling_id, nome) values ('77000000-0000-4000-8000-0000000000a1', '17000000001', 'Maria Atualizada')
      on conflict (organizacao_id, bling_id) do update set nome = excluded.nome$$,
    '20. depois dela, a sincronização volta a gravar o contato');
-- A reativação desta transação aconteceu em now(). A exclusão antiga (10:00 de
-- hoje, a mesma de 1) chega de novo com outra chave de idempotência.
create temp table r5 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', now() - interval '1 day');
select is((select desfecho from r5) || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '17000000001' and organizacao_id = '77000000-0000-4000-8000-0000000000a1')
          || '/' || (select (excluido_no_bling_em is null) from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'anterior_a_reativacao/1/true', '21. a exclusão antiga reentregue não desfaz a reativação');
create temp table r6 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', null);
select is((select desfecho from r6) || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '17000000001' and organizacao_id = '77000000-0000-4000-8000-0000000000a1')
          || '/' || (select (excluido_no_bling_em is null) from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'reconciliacao_necessaria/1/true', '22. sem data, a ordem não é provável: o estado local fica e pede reconciliação');
create temp table r7 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', now() + interval '1 minute');
select is((select desfecho from r7) || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '17000000001' and organizacao_id = '77000000-0000-4000-8000-0000000000a1'),
          'reconciliacao_necessaria/1', '23. dentro da margem dos relógios também: nada muda, pede reconciliação');
create temp table r8 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', now() + interval '1 hour');
select is((select desfecho from r8)
          || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '17000000001' and organizacao_id = '77000000-0000-4000-8000-0000000000a1')
          || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '17000000001' and organizacao_id = '77000000-0000-4000-8000-0000000000a1' and reativado_em is null)
          || '/' || (select (excluido_no_bling_em is not null) from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'registrado/2/1/true', '24. exclusão comprovadamente posterior à reativação vale: o histórico guarda as duas, uma vigente');

-- ----------------------------------------------------------------------------
-- 25-28. Falha transacional, entrada inválida, cascata e privilégios.
-- ----------------------------------------------------------------------------
do $$
begin
    perform * from public.registrar_exclusao_de_contato_no_bling('77000000-0000-4000-8000-0000000000a1', '55555', null);
    raise exception 'queda simulada depois do registro';
exception when others then
    null;
end $$;
select is((select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '55555')
          || '/' || (select (excluido_no_bling_em is null) from public.clientes where id = '77000000-0000-4000-8000-000000000003'),
          '0/true', '25. a transação que cai não deixa exclusão nem marca; a reentrega refaz do zero');

select throws_ok(
    $$select * from public.registrar_exclusao_de_contato_no_bling('77000000-0000-4000-8000-0000000000a1', 'temp_ab12', null)$$,
    '22023', null, '26. id que não é do Bling é recusado');

select * from public.registrar_exclusao_de_contato_no_bling('77000000-0000-4000-8000-0000000000c1', '123456', null);
delete from public.organizacoes where id = '77000000-0000-4000-8000-0000000000c1';
select ok(not exists (select 1 from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000c1')
          and (select count(*) from public.contatos_excluidos_no_bling) > 0,
          '27. a exclusão da organização leva só as exclusões dela');

select ok(not has_function_privilege('authenticated', 'public.registrar_exclusao_de_contato_no_bling(uuid, text, timestamptz)', 'execute')
          and not has_function_privilege('anon', 'public.reativar_contato_excluido_no_bling(uuid, text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.reativar_contato_excluido_no_bling(uuid, text, uuid)', 'execute')
          and has_function_privilege('service_role', 'public.registrar_exclusao_de_contato_no_bling(uuid, text, timestamptz)', 'execute')
          and has_function_privilege('service_role', 'public.reativar_contato_excluido_no_bling(uuid, text, uuid)', 'execute')
          and not has_table_privilege('authenticated', 'public.contatos_excluidos_no_bling', 'select')
          and not has_table_privilege('service_role', 'public.contatos_excluidos_no_bling', 'delete')
          and not has_column_privilege('service_role', 'public.contatos_excluidos_no_bling', 'bling_id', 'update')
          and (select relrowsecurity from pg_class where oid = 'public.contatos_excluidos_no_bling'::regclass),
          '28. só o servidor registra e reativa; o navegador não lê; RLS ligada');

select * from finish();
rollback;
