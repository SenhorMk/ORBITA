-- replay_de_item_nao_consome_estoque.test.sql
--
-- Invariante sob teste: a disponibilidade é cobrada pelo AUMENTO da quantidade
-- da linha, nunca por reaplicá-la. Reaplicar o mesmo estado tem delta zero;
-- demanda nova sem disponibilidade continua recusada.
--
-- O caminho exercido é o de `PedidoRepository.addItems`:
-- `insert ... on conflict (pedido_id, produto_id) do update`, com o
-- BEFORE INSERT rodando ANTES da resolução do conflito.
--
-- REINTRODUZIR O DEFEITO: troque o `\ir` da migration 66 por nada. A asserção
-- 2 falha com `check_violation` — o replay do item existente sobre estoque
-- zero é lido como demanda nova.

begin;

create table public.clientes (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    nome    text not null
);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
    nome              text not null,
    estoque           integer not null default 0,
    estoque_reservado integer not null default 0,
    constraint chk_produto_estoque   check (estoque >= 0),
    constraint chk_produto_reservado check (estoque_reservado >= 0)
);

create table public.pedidos (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    bling_id   text unique,
    cliente_id uuid not null references public.clientes(id) on delete restrict,
    total      numeric(12,2) not null default 0.00,
    status     text not null default 'Pendente',
    origem     text not null default 'Bling',
    updated_at timestamptz not null default now()
);

create table public.itens_pedido (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid references auth.users(id) on delete cascade,
    pedido_id      uuid not null references public.pedidos(id) on delete cascade,
    produto_id     uuid not null references public.produtos(id) on delete restrict,
    quantidade     int not null default 1,
    valor_unitario numeric(12,2) not null default 0.00,
    updated_at     timestamptz not null default now(),
    constraint chk_item_quantidade     check (quantidade > 0),
    constraint unq_item_pedido_produto unique (pedido_id, produto_id)
);

insert into auth.users (id, email) values ('66000000-0000-4000-8000-000000000001', 'owner-t66@orbita.test');

-- As regras de reserva vigentes (58 e 60) entram inteiras: este arquivo não as
-- altera, e elas precisam continuar valendo ao lado da validação corrigida.
\ir ../../../database/58_reserva_nao_conta_pedido_finalizado.sql
\ir ../../../database/60_reserva_nao_conta_venda_manual.sql
\ir ../../../database/66_replay_de_item_nao_consome_estoque.sql

-- A ligação dos dois gatilhos de itens, como no bootstrap canônico.
create trigger tg_atualizar_estoque_reservado
after insert or update or delete on itens_pedido for each row execute function fn_atualizar_estoque_reservado();
create trigger tg_validar_estoque_disponivel
before insert or update on itens_pedido for each row execute function fn_validar_estoque_disponivel();

insert into public.clientes (id, user_id, nome)
values ('66300000-0000-4000-8000-00000000000a', '66000000-0000-4000-8000-000000000001', 'Cliente T66');

insert into public.produtos (id, user_id, nome, estoque, estoque_reservado) values
    -- Chega ao baseline do staging pelo caminho real: a venda manual insere o
    -- item e SÓ DEPOIS baixa o físico. Começa com 1 em estoque.
    ('66200000-0000-4000-8000-00000000000a', '66000000-0000-4000-8000-000000000001', 'Manual Zerado', 1, 0),
    -- Pedido do Bling com uma unidade disponível.
    ('66200000-0000-4000-8000-00000000000b', '66000000-0000-4000-8000-000000000001', 'Bling Um', 1, 0),
    -- Produto para a venda manual nova, com o físico ainda por baixar.
    ('66200000-0000-4000-8000-00000000000c', '66000000-0000-4000-8000-000000000001', 'Manual Novo', 1, 0);

select plan(12);

-- ============================================================================
-- O cenário de regressão do staging.
-- ============================================================================
insert into public.pedidos (id, user_id, cliente_id, bling_id, total, status, origem)
values ('66400000-0000-4000-8000-00000000000a', '66000000-0000-4000-8000-000000000001',
        '66300000-0000-4000-8000-00000000000a', '26801269702', 40.00, 'Pendente', 'Loja Física / Manual');

insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('66000000-0000-4000-8000-000000000001', '66400000-0000-4000-8000-00000000000a',
        '66200000-0000-4000-8000-00000000000a', 1, 40.00);

-- A baixa física que `baixar_estoque_organizacao` faz em seguida.
update public.produtos set estoque = estoque - 1
 where id = '66200000-0000-4000-8000-00000000000a';

select is(
    (select estoque || '/' || estoque_reservado from public.produtos where id = '66200000-0000-4000-8000-00000000000a'),
    '0/0',
    '1. baseline do staging: estoque 0, reservado 0, item de quantidade 1 já gravado'
);

-- O MESMO upsert de `PedidoRepository.addItems`, com o mesmo item.
select lives_ok(
    $$insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
      values ('66000000-0000-4000-8000-000000000001', '66400000-0000-4000-8000-00000000000a',
              '66200000-0000-4000-8000-00000000000a', 1, 40.00)
      on conflict (pedido_id, produto_id)
      do update set quantidade = excluded.quantidade, valor_unitario = excluded.valor_unitario$$,
    '2. reaplicar o mesmo item sobre estoque zero é aceito'
);

select is(
    (select count(*)::int from public.itens_pedido where pedido_id = '66400000-0000-4000-8000-00000000000a'),
    1,
    '3. continua uma única linha'
);

select is(
    (select quantidade from public.itens_pedido
      where pedido_id = '66400000-0000-4000-8000-00000000000a'
        and produto_id = '66200000-0000-4000-8000-00000000000a'),
    1,
    '4. a quantidade continua 1'
);

select is(
    (select estoque || '/' || estoque_reservado from public.produtos where id = '66200000-0000-4000-8000-00000000000a'),
    '0/0',
    '5. estoque e reserva não se movem no replay'
);

-- ============================================================================
-- Demanda nova real continua protegida.
-- ============================================================================
insert into public.pedidos (id, user_id, cliente_id, bling_id, total, status, origem)
values ('66400000-0000-4000-8000-00000000000b', '66000000-0000-4000-8000-000000000001',
        '66300000-0000-4000-8000-00000000000a', '26852358980', 40.00, 'Pendente', 'Bling');

insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('66000000-0000-4000-8000-000000000001', '66400000-0000-4000-8000-00000000000b',
        '66200000-0000-4000-8000-00000000000b', 1, 40.00);

select is(
    (select estoque_reservado from public.produtos where id = '66200000-0000-4000-8000-00000000000b'),
    1,
    '6. pedido do Bling continua reservando'
);

-- Subir a quantidade sem disponibilidade: estoque 1, reservado 1, delta 1.
select throws_ok(
    $$update public.itens_pedido set quantidade = 2
       where pedido_id = '66400000-0000-4000-8000-00000000000b'
         and produto_id = '66200000-0000-4000-8000-00000000000b'$$,
    '23514',
    null,
    '7. aumento de demanda sem disponibilidade continua recusado'
);

-- E o replay do mesmo item do Bling, que não aumenta nada, passa.
select lives_ok(
    $$insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
      values ('66000000-0000-4000-8000-000000000001', '66400000-0000-4000-8000-00000000000b',
              '66200000-0000-4000-8000-00000000000b', 1, 40.00)
      on conflict (pedido_id, produto_id)
      do update set quantidade = excluded.quantidade$$,
    '8. replay do item do Bling com a mesma quantidade é aceito'
);

select is(
    (select estoque_reservado from public.produtos where id = '66200000-0000-4000-8000-00000000000b'),
    1,
    '9. o replay não reserva de novo'
);

-- Reduzir libera reserva, e ela não fica negativa.
insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('66000000-0000-4000-8000-000000000001', '66400000-0000-4000-8000-00000000000b',
        '66200000-0000-4000-8000-00000000000b', 1, 40.00)
on conflict (pedido_id, produto_id) do update set quantidade = 1;

select cmp_ok(
    (select estoque_reservado from public.produtos where id = '66200000-0000-4000-8000-00000000000b'),
    '>=', 0,
    '10. a reserva nunca fica negativa'
);

-- ============================================================================
-- Venda manual NOVA: o físico ainda não saiu, e a disponibilidade é exigida.
-- ============================================================================
insert into public.pedidos (id, user_id, cliente_id, bling_id, total, status, origem)
values ('66400000-0000-4000-8000-00000000000c', '66000000-0000-4000-8000-000000000001',
        '66300000-0000-4000-8000-00000000000a', '26852358981', 40.00, 'Entregue', 'Loja Física / Manual');

-- `registrar_venda_manual` insere os itens ANTES de baixar o estoque: uma
-- unidade disponível para uma unidade vendida.
select lives_ok(
    $$insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
      values ('66000000-0000-4000-8000-000000000001', '66400000-0000-4000-8000-00000000000c',
              '66200000-0000-4000-8000-00000000000c', 1, 40.00)$$,
    '11. venda manual nova com estoque suficiente é aceita'
);

select is(
    (select estoque_reservado from public.produtos where id = '66200000-0000-4000-8000-00000000000c'),
    0,
    '12. venda manual não reserva — a regra da migration 60 segue valendo'
);

select * from finish();
rollback;
