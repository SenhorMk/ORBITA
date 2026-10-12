-- arquivamento_de_produto.test.sql
-- PRE-003, migration 75: arquivar retira da venda sem apagar o produto nem o
-- histórico; o item guarda o retrato do produto; produto com histórico não é
-- apagado por DELETE direto.
--
-- REINTRODUZIR O DEFEITO: tire o gatilho `tg_produto_com_historico_nao_e_excluido`:
-- 16 falha (o DELETE direto apaga o produto e o CASCADE leva a movimentação
-- de estoque junto; a 15 continua protegida pela FK `fk_item_produto`). Tire o
-- ramo `old.situacao = 'arquivado'` do ciclo de vida: a 11 aborta (a gravação
-- da sincronização num arquivado deixa de funcionar). Tire a preservação do
-- retrato no UPDATE: 4, 5 e 14 falham.

begin;

create table public.organizacoes (id uuid primary key);

create table public.clientes (
    id uuid primary key default gen_random_uuid(),
    nome text not null
);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    organizacao_id    uuid not null references public.organizacoes(id) on delete cascade,
    nome              text not null,
    codigo            text,
    preco             numeric(12,2) not null default 0,
    estoque           integer not null default 0,
    estoque_reservado integer not null default 0,
    constraint chk_produto_estoque   check (estoque >= 0),
    constraint chk_produto_reservado check (estoque_reservado >= 0)
);

create table public.pedidos (
    id         uuid primary key default gen_random_uuid(),
    cliente_id uuid not null references public.clientes(id) on delete restrict,
    status     text not null default 'Pendente',
    origem     text not null default 'Bling',
    updated_at timestamptz not null default now()
);

create table public.itens_pedido (
    id             uuid primary key default gen_random_uuid(),
    pedido_id      uuid not null references public.pedidos(id) on delete cascade,
    produto_id     uuid not null references public.produtos(id) on delete restrict,
    quantidade     int not null default 1,
    valor_unitario numeric(12,2) not null default 0.00,
    updated_at     timestamptz not null default now(),
    constraint chk_item_quantidade     check (quantidade > 0),
    constraint unq_item_pedido_produto unique (pedido_id, produto_id)
);

create table public.movimentacao_estoque (
    id         uuid primary key default gen_random_uuid(),
    produto_id uuid not null references public.produtos(id) on delete cascade,
    quantidade integer not null
);

-- As regras de reserva vigentes entram inteiras: o arquivamento não pode
-- mexer nelas.
\ir ../../../database/58_reserva_nao_conta_pedido_finalizado.sql
\ir ../../../database/60_reserva_nao_conta_venda_manual.sql
\ir ../../../database/66_replay_de_item_nao_consome_estoque.sql

create trigger tg_atualizar_estoque_reservado
after insert or update or delete on itens_pedido for each row execute function fn_atualizar_estoque_reservado();
create trigger tg_validar_estoque_disponivel
before insert or update on itens_pedido for each row execute function fn_validar_estoque_disponivel();

insert into public.organizacoes values ('75000000-0000-4000-8000-0000000000a1'), ('75000000-0000-4000-8000-0000000000b1');
insert into public.clientes (id, nome) values ('75000000-0000-4000-8000-0000000000c1', 'Cliente sintético');
insert into public.produtos (id, organizacao_id, nome, codigo, preco, estoque) values
    ('75000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-0000000000a1', 'Camiseta Azul', 'CAM-AZ', 50, 10),
    ('75000000-0000-4000-8000-000000000002', '75000000-0000-4000-8000-0000000000a1', 'Caneca', 'CAN-01', 30, 5),
    ('75000000-0000-4000-8000-000000000003', '75000000-0000-4000-8000-0000000000a1', 'Sem histórico', 'SEM-01', 10, 0),
    ('75000000-0000-4000-8000-000000000005', '75000000-0000-4000-8000-0000000000a1', 'Só movimentação', 'MOV-01', 10, 4),
    ('75000000-0000-4000-8000-000000000004', '75000000-0000-4000-8000-0000000000b1', 'Produto de B', 'B-01', 10, 3);
insert into public.pedidos (id, cliente_id) values ('75000000-0000-4000-8000-0000000000d1', '75000000-0000-4000-8000-0000000000c1');
-- Item anterior à migration: o retrato vem do backfill.
insert into public.itens_pedido (pedido_id, produto_id, quantidade, valor_unitario)
values ('75000000-0000-4000-8000-0000000000d1', '75000000-0000-4000-8000-000000000001', 2, 49.90);
insert into public.movimentacao_estoque (produto_id, quantidade) values
    ('75000000-0000-4000-8000-000000000002', -1),
    ('75000000-0000-4000-8000-000000000005', 4);

\ir ../../../database/75_arquivamento_de_produto.sql

select plan(20);

-- ----------------------------------------------------------------------------
-- 1-5. O item guarda o retrato do produto.
-- ----------------------------------------------------------------------------
select is((select produto_nome || '/' || produto_codigo from public.itens_pedido
            where produto_id = '75000000-0000-4000-8000-000000000001'), 'Camiseta Azul/CAM-AZ',
          '1. o item anterior à migration recebe o retrato do produto');

insert into public.itens_pedido (pedido_id, produto_id, quantidade, valor_unitario, produto_nome, produto_codigo)
values ('75000000-0000-4000-8000-0000000000d1', '75000000-0000-4000-8000-000000000002', 1, 29.90, 'Nome forjado', 'X');
select is((select produto_nome || '/' || produto_codigo from public.itens_pedido
            where produto_id = '75000000-0000-4000-8000-000000000002'), 'Caneca/CAN-01',
          '2. o retrato vem do produto, nunca do chamador');

update public.produtos set nome = 'Camiseta Azul Royal', codigo = 'CAM-AZR' where id = '75000000-0000-4000-8000-000000000001';
select is((select produto_nome from public.itens_pedido where produto_id = '75000000-0000-4000-8000-000000000001'),
          'Camiseta Azul', '3. renomear o produto não reescreve o pedido antigo');

update public.itens_pedido set produto_nome = 'Adulterado' where produto_id = '75000000-0000-4000-8000-000000000001';
select is((select produto_nome from public.itens_pedido where produto_id = '75000000-0000-4000-8000-000000000001'),
          'Camiseta Azul', '4. nem uma gravação direta no item');

insert into public.itens_pedido (pedido_id, produto_id, quantidade, valor_unitario)
values ('75000000-0000-4000-8000-0000000000d1', '75000000-0000-4000-8000-000000000001', 2, 49.90)
on conflict (pedido_id, produto_id) do update set quantidade = excluded.quantidade, valor_unitario = excluded.valor_unitario;
select is((select produto_nome || '/' || valor_unitario from public.itens_pedido where produto_id = '75000000-0000-4000-8000-000000000001'),
          'Camiseta Azul/49.90', '5. o replay do item pela sincronização mantém nome e valor históricos');

-- ----------------------------------------------------------------------------
-- 6-13. Arquivar.
-- ----------------------------------------------------------------------------
create temp table antes as
    select estoque, estoque_reservado from public.produtos where id = '75000000-0000-4000-8000-000000000001';

create temp table a1 as select * from public.arquivar_produto(
    '75000000-0000-4000-8000-0000000000a1', '75000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-0000000000e1');
select is((select desfecho || '/' || situacao_anterior from a1), 'arquivado/ativo', '6. arquivar um produto ativo');
select is((select situacao || '/' || (arquivado_por = '75000000-0000-4000-8000-0000000000e1') from public.produtos
            where id = '75000000-0000-4000-8000-000000000001'), 'arquivado/true', '7. com quem arquivou');
select ok((select p.estoque = a.estoque and p.estoque_reservado = a.estoque_reservado and p.estoque_reservado = 2
             from public.produtos p, antes a where p.id = '75000000-0000-4000-8000-000000000001')
          and (select count(*) from public.movimentacao_estoque where produto_id = '75000000-0000-4000-8000-000000000001') = 0,
          '8. arquivar não mexe em estoque, reserva nem movimentação');

create temp table a2 as select * from public.arquivar_produto(
    '75000000-0000-4000-8000-0000000000a1', '75000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-0000000000e2');
select is((select desfecho || '/' || (arquivado_em = (select arquivado_em from a1)) from a2), 'ja_arquivado/true',
          '9. arquivar de novo é idempotente e não reescreve quando nem quem');

select throws_ok(
    $$select * from public.arquivar_produto('75000000-0000-4000-8000-0000000000b1', '75000000-0000-4000-8000-000000000001',
                                            '75000000-0000-4000-8000-0000000000e1')$$,
    'P0002', null, '10. outra organização não arquiva o produto de A');

update public.produtos set situacao = 'ativo', preco = 55, estoque = 9 where id = '75000000-0000-4000-8000-000000000001';
select is((select situacao || '/' || preco || '/' || estoque from public.produtos where id = '75000000-0000-4000-8000-000000000001'),
          'arquivado/55.00/9', '11. a sincronização atualiza preço e estoque, mas não desarquiva');

select throws_ok(
    $$update public.produtos set situacao = 'arquivado', arquivado_em = now() where id = '75000000-0000-4000-8000-000000000002'$$,
    '23514', null, '12. arquivar por gravação comum é recusado');
select throws_ok(
    $$insert into public.produtos (organizacao_id, nome, situacao, arquivado_em)
      values ('75000000-0000-4000-8000-0000000000a1', 'Nasce arquivado', 'arquivado', now())$$,
    '23514', null, '13. produto não nasce arquivado');

-- ----------------------------------------------------------------------------
-- 14-18. Histórico preservado; nada de hard-delete com histórico.
-- ----------------------------------------------------------------------------
select is((select i.produto_nome || '/' || i.valor_unitario || '/' || p.situacao
             from public.itens_pedido i join public.produtos p on p.id = i.produto_id
            where i.produto_id = '75000000-0000-4000-8000-000000000001'),
          'Camiseta Azul/49.90/arquivado', '14. o pedido antigo continua com item, nome e valor, e o produto consultável');

select throws_ok(
    $$delete from public.produtos where id = '75000000-0000-4000-8000-000000000001'$$,
    '23503', null, '15. produto com pedido não é apagado');
-- Produto SÓ com movimentação (sem item de pedido): sem a guarda, o CASCADE de
-- `movimentacao_estoque` apagaria o histórico de estoque junto.
select throws_ok(
    $$delete from public.produtos where id = '75000000-0000-4000-8000-000000000005'$$,
    '23503', null, '16. nem produto só com movimentação de estoque');
select lives_ok(
    $$delete from public.produtos where id = '75000000-0000-4000-8000-000000000003'$$,
    '17. produto sem histórico ainda pode sair (deduplicação)');

update public.pedidos set status = 'Cancelado' where id = '75000000-0000-4000-8000-0000000000d1';
select is((select estoque_reservado from public.produtos where id = '75000000-0000-4000-8000-000000000001'), 0,
          '18. a reserva de um produto arquivado é liberada quando o pedido é cancelado');

-- ----------------------------------------------------------------------------
-- 19-20. Exclusão em cascata e privilégios.
-- ----------------------------------------------------------------------------
insert into public.movimentacao_estoque (produto_id, quantidade) values ('75000000-0000-4000-8000-000000000004', 1);
delete from public.organizacoes where id = '75000000-0000-4000-8000-0000000000b1';
select is((select count(*)::int from public.produtos where organizacao_id = '75000000-0000-4000-8000-0000000000b1'), 0,
          '19. a exclusão da organização segue em cascata, como antes');

select ok(not has_function_privilege('authenticated', 'public.arquivar_produto(uuid, uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.arquivar_produto(uuid, uuid, uuid)', 'execute')
          and has_function_privilege('service_role', 'public.arquivar_produto(uuid, uuid, uuid)', 'execute'),
          '20. só o servidor arquiva');

select * from finish();
rollback;
