-- contato_excluido_no_bling.test.sql
-- PRE-005, migration 77: `contact.deleted` do Bling marca o contato como
-- excluído sem apagá-lo nem inventar nome; pedidos continuam legíveis; um
-- update atrasado não o traz de volta; só a reconciliação explícita traz.
-- Depois de uma reativação, exclusão sem ordem provável abre pendência que
-- bloqueia o contato até a conferência no Bling.
--
-- REINTRODUZIR O DEFEITO (medido):
-- - sem o gatilho `tg_contato_excluido_no_bling_nao_volta`: 6-11, 24 e 25 falham;
-- - sem absorver a reentrega da exclusão confirmada: 4 falha;
-- - registro de exclusão mutável: 15-17 falham (e 19, 21-23, 25, 28, 29, 31);
-- - sem a checagem de papel: 18 e 26 falham (e 19);
-- - sem a guarda de data: 21-23 falham (e 25, 28, 29, 32);
-- - pendência sem marca no contato (só aviso): 22 e 25 falham;
-- - sem a checagem da mesma entrega: 28 falha (e 29).

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

select plan(38);

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
-- 15-20. Registro permanente; só o comando explícito encerra.
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

create temp table r4 as select * from public.reativar_contato_excluido_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000001', '77000000-0000-4000-8000-0000000000f1');
select is((select desfecho from r4) || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000001')
          || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '17000000001' and reativado_por = '77000000-0000-4000-8000-0000000000f1'),
          'reativado/false/false/1', '19. a reativação explícita traz o contato de volta e registra quem reativou');
select lives_ok(
    $$insert into public.clientes (organizacao_id, bling_id, nome) values ('77000000-0000-4000-8000-0000000000a1', '17000000001', 'Maria Atualizada')
      on conflict (organizacao_id, bling_id) do update set nome = excluded.nome$$,
    '20. depois dela, a sincronização volta a gravar o contato');

-- ----------------------------------------------------------------------------
-- 21-34. Depois da reativação (em now()): exclusão antiga não a desfaz; sem
-- ordem provável, o contato fica pendente e bloqueado até a conferência.
-- ----------------------------------------------------------------------------
create temp table r5 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', now() - interval '1 day', 'k-antiga');
select is((select desfecho from r5) || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001') || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'anterior_a_reativacao/1/false/false', '21. a exclusão antiga comprovada não bloqueia o contato reativado');
create temp table r6 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', null, 'k1');
select is((select desfecho from r6) || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001') || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000001')
          || '/' || (select confirmada::text from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001' and reativado_em is null),
          'reconciliacao_necessaria/2/false/true/false', '22. sem ordem provável: pendência aberta, não confirmada; o contato fica pendente, não excluído');
create temp table r7 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', now() + interval '1 minute', 'k2');
select is((select desfecho from r7) || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001'),
          'reconciliacao_pendente/2', '23. outra entrega sem ordem provável não abre outra pendência');
select throws_ok(
    $$insert into public.clientes (organizacao_id, bling_id, nome) values ('77000000-0000-4000-8000-0000000000a1', '17000000001', 'Durante a pendência')
      on conflict (organizacao_id, bling_id) do update set nome = excluded.nome$$,
    '23514', null, '24. durante a pendência, a gravação do contato é recusada');
select throws_ok(
    $$update public.clientes set exclusao_pendente_desde = null where id = '77000000-0000-4000-8000-000000000001'$$,
    '23514', null, '25. nem a pendência se limpa por gravação direta');
select throws_ok(
    $$select * from public.confirmar_exclusao_pendente_de_contato('77000000-0000-4000-8000-0000000000a1', '17000000001', '77000000-0000-4000-8000-0000000000f2')$$,
    '42501', null, '26. quem não administra a organização não confirma a exclusão');

-- O Bling confirmou o contato ativo: a reconciliação encerra a pendência.
create temp table r8 as select * from public.reativar_contato_excluido_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000001', '77000000-0000-4000-8000-0000000000f1');
select is((select desfecho from r8) || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000001') || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001' and reativado_em is null),
          'reativado/false/false/0', '27. confirmação de contato ativo resolve a pendência e libera o contato');
create temp table r9 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', null, 'k1');
select is((select desfecho from r9) || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001') || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'ja_resolvido/2/false/false', '28. a reentrega da entrega que abriu a pendência resolvida não a reabre');

-- Nova entrega sem ordem provável; desta vez o Bling confirma a exclusão.
create temp table r10 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', null, 'k3');
create temp table r11 as select * from public.confirmar_exclusao_pendente_de_contato('77000000-0000-4000-8000-0000000000a1', '17000000001', '77000000-0000-4000-8000-0000000000f1');
select is((select desfecho from r10) || '/' || (select desfecho from r11) || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000001')
          || '/' || (select confirmada::text from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001' and reativado_em is null),
          'reconciliacao_necessaria/confirmada/true/false/true', '29. contato ainda excluído no Bling: a pendência vira exclusão confirmada');
create temp table r12 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', null, 'k3');
create temp table r13 as select * from public.confirmar_exclusao_pendente_de_contato('77000000-0000-4000-8000-0000000000a1', '17000000001', '77000000-0000-4000-8000-0000000000f1');
select is((select desfecho from r12) || '/' || (select desfecho from r13) || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'ja_registrado/sem_pendencia/true/false', '30. a reentrega e a segunda confirmação não mudam nada; o contato segue excluído');

-- Exclusão genuinamente nova depois de outra reativação.
create temp table r14 as select * from public.reativar_contato_excluido_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000001', '77000000-0000-4000-8000-0000000000f1');
create temp table r15 as select * from public.registrar_exclusao_de_contato_no_bling(
    '77000000-0000-4000-8000-0000000000a1', '17000000001', now() + interval '1 hour', 'k4');
select is((select desfecho from r14) || '/' || (select desfecho from r15) || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001') || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000a1' and bling_id = '17000000001' and reativado_em is null) || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000001'),
          'reativado/registrado/4/1/true/false', '31. exclusão comprovadamente posterior à reativação vale: histórico com quatro, uma aberta');

-- Pendência aberta + exclusão comprovadamente posterior: a pendência é confirmada.
insert into public.clientes (id, organizacao_id, bling_id, nome) values ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-0000000000a1', '17000000005', 'Joana');
select * from public.registrar_exclusao_de_contato_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000005', null, 'j1');
select * from public.reativar_contato_excluido_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000005', '77000000-0000-4000-8000-0000000000f1');
create temp table r16 as select * from public.registrar_exclusao_de_contato_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000005', null, 'j2');
create temp table r17 as select * from public.registrar_exclusao_de_contato_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000005', now() + interval '1 hour', 'j3');
select is((select desfecho from r16) || '/' || (select desfecho from r17)
          || '/' || (select (excluido_no_bling_em is not null)::text || '/' || (exclusao_pendente_desde is not null)::text from public.clientes where id = '77000000-0000-4000-8000-000000000005')
          || '/' || (select count(*)::int from public.contatos_excluidos_no_bling where bling_id = '17000000005' and reativado_em is null and confirmada),
          'reconciliacao_necessaria/registrado/true/false/1', '32. pendência aberta + exclusão comprovadamente posterior: confirmada, sem segunda linha aberta');
select is((select desfecho from public.reativar_contato_excluido_no_bling('77000000-0000-4000-8000-0000000000a1', '17000000005', '77000000-0000-4000-8000-0000000000f1')), 'reativado',
          '33. e a pendência confirmada também só sai pela reativação explícita');
select is((select (excluido_no_bling_em is null and exclusao_pendente_desde is null) from public.clientes where id = '77000000-0000-4000-8000-000000000002'),
          true, '34. organização B: o mesmo bling_id não recebe exclusão nem pendência de A');

-- ----------------------------------------------------------------------------
-- 35-38. Falha transacional, entrada inválida, cascata e privilégios.
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
          '0/true', '35. a transação que cai não deixa exclusão nem marca; a reentrega refaz do zero');

select throws_ok(
    $$select * from public.registrar_exclusao_de_contato_no_bling('77000000-0000-4000-8000-0000000000a1', 'temp_ab12', null)$$,
    '22023', null, '36. id que não é do Bling é recusado');

select * from public.registrar_exclusao_de_contato_no_bling('77000000-0000-4000-8000-0000000000c1', '123456', null);
delete from public.organizacoes where id = '77000000-0000-4000-8000-0000000000c1';
select ok(not exists (select 1 from public.contatos_excluidos_no_bling where organizacao_id = '77000000-0000-4000-8000-0000000000c1')
          and (select count(*) from public.contatos_excluidos_no_bling) > 0,
          '37. a exclusão da organização leva só as exclusões dela');

select ok(not has_function_privilege('authenticated', 'public.registrar_exclusao_de_contato_no_bling(uuid, text, timestamptz, text)', 'execute')
          and not has_function_privilege('anon', 'public.reativar_contato_excluido_no_bling(uuid, text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.reativar_contato_excluido_no_bling(uuid, text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.confirmar_exclusao_pendente_de_contato(uuid, text, uuid)', 'execute')
          and has_function_privilege('service_role', 'public.registrar_exclusao_de_contato_no_bling(uuid, text, timestamptz, text)', 'execute')
          and has_function_privilege('service_role', 'public.reativar_contato_excluido_no_bling(uuid, text, uuid)', 'execute')
          and has_function_privilege('service_role', 'public.confirmar_exclusao_pendente_de_contato(uuid, text, uuid)', 'execute')
          and not has_table_privilege('authenticated', 'public.contatos_excluidos_no_bling', 'select')
          and not has_table_privilege('service_role', 'public.contatos_excluidos_no_bling', 'delete')
          and not has_column_privilege('service_role', 'public.contatos_excluidos_no_bling', 'bling_id', 'update')
          and not has_column_privilege('service_role', 'public.contatos_excluidos_no_bling', 'chave_do_evento', 'update')
          and (select relrowsecurity from pg_class where oid = 'public.contatos_excluidos_no_bling'::regclass),
          '38. só o servidor registra, confirma e reativa; o navegador não lê; RLS ligada');

select * from finish();
rollback;
