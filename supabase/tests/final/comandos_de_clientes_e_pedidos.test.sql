-- comandos_de_clientes_e_pedidos.test.sql
-- PRE-006C, migration 80, contra o schema canônico completo.
--
-- `registrar_cliente_do_sac`: só insere, nunca sobrescreve, não cruza
-- organização, recusa ator de fora, e só `service_role` executa.
-- `alinhar_estoque_ao_saldo_do_bling`: escreve só se o estoque ainda for o
-- lido, lança o delta no livro na mesma transação, repete sem lançar de novo,
-- não cruza organização e recusa saldo negativo sem escrever.
-- A concorrência (trava consultiva e trava da linha) está em
-- `scripts/database-concurrency-comandos-comerciais.mjs`.
--
-- REINTRODUZIR O DEFEITO: trocar o compare-and-set por escrita incondicional
-- derruba 9; remover o insert no livro derruba 8; remover o teste de
-- membership derruba 5 e 12; conceder EXECUTE a `authenticated` derruba 6 e 14.

begin;

select plan(16);

insert into auth.users (id, email) values
    ('c6000000-0000-4000-8000-0000000000a1', 'dono-a-t6c@orbita.test'),
    ('c6000000-0000-4000-8000-0000000000a2', 'atendente-a-t6c@orbita.test'),
    ('c6000000-0000-4000-8000-0000000000b1', 'dono-b-t6c@orbita.test');
insert into public.organizacoes (id, nome, slug, status) values
    ('c6000000-0000-4000-8000-00000000000a', 'Org A T6C', 'org-a-t6c', 'active'),
    ('c6000000-0000-4000-8000-00000000000b', 'Org B T6C', 'org-b-t6c', 'active');
insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a1', 'owner'),
    ('c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a2', 'member'),
    ('c6000000-0000-4000-8000-00000000000b', 'c6000000-0000-4000-8000-0000000000b1', 'owner');
insert into public.clientes (id, organizacao_id, user_id, bling_id, nome, telefone_normalizado) values
    ('c6000000-0000-4000-8000-0000000000c1', 'c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a1',
     '6101', 'Maria Real', '+5548900000001');
insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, preco, estoque) values
    ('c6000000-0000-4000-8000-0000000000f1', 'c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a1', '6201', 'Produto de A', 10, 5),
    ('c6000000-0000-4000-8000-0000000000f2', 'c6000000-0000-4000-8000-00000000000b', 'c6000000-0000-4000-8000-0000000000b1', '6202', 'Produto de B', 10, 5);

set local role service_role;
set local request.jwt.claim.role = 'service_role';

-- ----------------------------------------------------------------------------
-- 1-6. Auto-registro do SAC
-- ----------------------------------------------------------------------------
select is(
    (select desfecho from public.registrar_cliente_do_sac('c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a2',
        'Contato Novo', null, '(48) 90000-0002', '+5548900000002')),
    'criado', '1. o atendente (member) registra o cliente novo do SAC');
select is(
    (select bling_id ~ '^temp_' and user_id = 'c6000000-0000-4000-8000-0000000000a2' from public.clientes
      where organizacao_id = 'c6000000-0000-4000-8000-00000000000a' and telefone_normalizado = '+5548900000002'),
    true, '2. com bling_id temporário e o ator verificado como autor');
select is(
    (select desfecho from public.registrar_cliente_do_sac('c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a2',
        'Nome Trocado', 'x@exemplo.com', null, '+5548900000001')),
    'ja_existia', '3. telefone já cadastrado: não cria outro');
select is(
    (select nome || '|' || coalesce(email, '') from public.clientes where id = 'c6000000-0000-4000-8000-0000000000c1'),
    'Maria Real|', '4. e não sobrescreve o cliente existente');
select throws_ok(
    $$select * from public.registrar_cliente_do_sac('c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000b1',
        'Intruso', null, null, '+5548900000003')$$,
    '42501', null, '5. ator de outra organização é recusado, sem efeito');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = 'c6000000-0000-4000-8000-0000000000a1';
set local request.jwt.claim.role = 'authenticated';
select throws_ok(
    $$select * from public.registrar_cliente_do_sac('c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a1',
        'Navegador', null, null, '+5548900000004')$$,
    '42501', null, '6. o navegador (authenticated) não executa o comando');
reset role;

set local role service_role;
set local request.jwt.claim.role = 'service_role';

-- ----------------------------------------------------------------------------
-- 7-14. Alinhamento do estoque ao saldo do Bling
-- ----------------------------------------------------------------------------
select is(
    (select desfecho || ':' || estoque_final from public.alinhar_estoque_ao_saldo_do_bling(
        'c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a1', 'c6000000-0000-4000-8000-0000000000f1', 5, 3)),
    'alinhado:3', '7. leitura vigente: alinha ao saldo do Bling');
select is(
    (select tipo || ':' || quantidade || ':' || origem from public.movimentacao_estoque
      where produto_id = 'c6000000-0000-4000-8000-0000000000f1' and origem = 'ALINHAMENTO_SITUACAO_BLING'),
    'SAIDA:2:ALINHAMENTO_SITUACAO_BLING', '8. e lança o delta aplicado no livro, na mesma transação');
select is(
    (select desfecho || ':' || estoque_final from public.alinhar_estoque_ao_saldo_do_bling(
        'c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a1', 'c6000000-0000-4000-8000-0000000000f1', 9, 8)),
    'divergiu:3', '9. leitura velha (estoque mudou depois): não escreve');
select is(
    (select desfecho from public.alinhar_estoque_ao_saldo_do_bling(
        'c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a1', 'c6000000-0000-4000-8000-0000000000f1', 5, 3)),
    'ja_alinhado', '10. retry com o mesmo saldo: já alinhado');
select is(
    (select count(*)::int from public.movimentacao_estoque
      where produto_id = 'c6000000-0000-4000-8000-0000000000f1' and origem = 'ALINHAMENTO_SITUACAO_BLING'),
    1, '11. e nenhum lançamento novo');
select throws_ok(
    $$select * from public.alinhar_estoque_ao_saldo_do_bling('c6000000-0000-4000-8000-00000000000a',
        'c6000000-0000-4000-8000-0000000000a1', 'c6000000-0000-4000-8000-0000000000f2', 5, 1)$$,
    'P0002', null, '12. produto de outra organização não existe para o escopo');
select is(
    (select desfecho || ':' || estoque_final from public.alinhar_estoque_ao_saldo_do_bling(
        'c6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-0000000000a1', 'c6000000-0000-4000-8000-0000000000f1', 3, -2)),
    'saldo_invalido:3', '13. saldo negativo do Bling: recusa sem escrever');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = 'c6000000-0000-4000-8000-0000000000a1';
set local request.jwt.claim.role = 'authenticated';
select throws_ok(
    $$select * from public.alinhar_estoque_ao_saldo_do_bling('c6000000-0000-4000-8000-00000000000a',
        'c6000000-0000-4000-8000-0000000000a1', 'c6000000-0000-4000-8000-0000000000f1', 3, 50)$$,
    '42501', null, '14. o navegador não altera estoque pelo comando');
reset role;

-- ----------------------------------------------------------------------------
-- 15-16. Catálogo de auditoria e estoque de B intacto
-- ----------------------------------------------------------------------------
select is(
    (select count(*)::int from public.catalogo_eventos_auditoria where nome in (
        'customer.contact_saved', 'customer.contact_save_rejected', 'customer.contact_save_reconcile_required',
        'customer.sac_contacts_registered', 'order.status_changed', 'order.status_change_rejected', 'order.updated',
        'order.deleted', 'order.reconcile_required', 'order.manual_sale_recorded', 'order.manual_sale_unresolved')),
    11, '15. os onze eventos do PRE-006C estão no catálogo SQL');
select is(
    (select estoque from public.produtos where id = 'c6000000-0000-4000-8000-0000000000f2'),
    5, '16. nada do que foi feito em A tocou o estoque de B');

select * from finish();
rollback;
