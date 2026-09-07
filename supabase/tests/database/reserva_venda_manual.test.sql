-- reserva_venda_manual.test.sql
-- Ticket 30 — a regressão que só a jornada real no staging revelou.
--
-- Venda manual de 1 unidade derrubou a disponibilidade em 2:
--   baseline  estoque=2 reservado=0  -> disponível 2
--   depois    estoque=1 reservado=1  -> disponível 0
--
-- A venda manual baixa o estoque FISICAMENTE e conclui o pedido como
-- `Entregue`. O `order.created` chega depois, sincroniza a situação do Bling
-- e devolve a mesma linha para `Pendente`. A transição `Entregue -> Pendente`
-- re-reservava a quantidade sobre um estoque que já tinha saído.
--
-- Este teste fixa o invariante nas DUAS ordens da corrida, que é o que a
-- revisão pediu: webhook depois da venda manual (a ordem observada) e webhook
-- antes dela (a tomada da linha, migration 57).
--
-- Deliberadamente NÃO chama `registrar_venda_manual`: o defeito vive nos dois
-- gatilhos de reserva, e o que a venda manual faz por baixo — gravar
-- `origem='Loja Física / Manual'` + `status='Entregue'` e decrementar
-- `produtos.estoque` — está reproduzido aqui em SQL direto. O caminho
-- completo, com a RPC real e o gatilho de validação de disponibilidade, é
-- exercido pelo rehearsal `scripts/database-concurrency-reserva-manual.mjs`.
--
-- REINTRODUZIR O DEFEITO: troque o `\ir` da migration 60 por nada (fica só a
-- 58). As asserções 2 e 3 falham — a reserva ressuscita e a disponibilidade
-- cai 2.

begin;

create table public.clientes (
    id       uuid primary key default gen_random_uuid(),
    user_id  uuid references auth.users(id) on delete cascade,
    nome     text not null
);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
    nome              text not null,
    estoque           integer not null default 0,
    estoque_reservado integer not null default 0
);

create table public.pedidos (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete cascade,
    bling_id    text unique,
    numero      text,
    cliente_id  uuid not null references public.clientes(id) on delete restrict,
    total       numeric(12,2) not null default 0.00,
    status      text not null default 'Pendente',
    origem      text not null default 'Bling',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table public.itens_pedido (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    pedido_id       uuid not null references public.pedidos(id) on delete cascade,
    produto_id      uuid not null references public.produtos(id) on delete restrict,
    quantidade      int not null default 1,
    valor_unitario  numeric(12,2) not null default 0.00,
    updated_at      timestamptz not null default now(),
    constraint unq_item_pedido_produto unique (pedido_id, produto_id)
);

insert into auth.users (id, email) values ('60000000-0000-4000-8000-000000000001', 'owner-t60@orbita.test');

\ir ../../../database/58_reserva_nao_conta_pedido_finalizado.sql
\ir ../../../database/60_reserva_nao_conta_venda_manual.sql

-- As MESMAS ligações de `supabase/lab/00_bootstrap_schema.sql`.
create trigger tg_atualizar_estoque_reservado
after insert or update or delete on itens_pedido for each row execute function fn_atualizar_estoque_reservado();
create trigger tg_pedidos_reserva_status
after update of status on pedidos for each row execute function fn_atualizar_reserva_status_pedido();

insert into public.clientes (id, user_id, nome)
values ('60300000-0000-4000-8000-00000000000a', '60000000-0000-4000-8000-000000000001', 'Cliente T60');

-- Dois produtos com o MESMO baseline do caso real: 2 em estoque, 0 reservado.
insert into public.produtos (id, user_id, nome, estoque, estoque_reservado)
values
    ('60200000-0000-4000-8000-00000000000a', '60000000-0000-4000-8000-000000000001', 'Rapé A', 2, 0),
    ('60200000-0000-4000-8000-00000000000b', '60000000-0000-4000-8000-000000000001', 'Rapé B', 2, 0),
    ('60200000-0000-4000-8000-00000000000c', '60000000-0000-4000-8000-000000000001', 'Produto Bling', 2, 0);

select plan(9);

-- ============================================================================
-- ORDEM 1 — a observada no staging: venda manual conclui, webhook chega depois.
-- ============================================================================
-- A venda manual grava o pedido já `Entregue`, com origem manual…
insert into public.pedidos (id, user_id, cliente_id, bling_id, numero, total, status, origem)
values ('60400000-0000-4000-8000-00000000000a', '60000000-0000-4000-8000-000000000001',
        '60300000-0000-4000-8000-00000000000a', '26801269702', '26801269702', 40.00,
        'Entregue', 'Loja Física / Manual');
insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('60000000-0000-4000-8000-000000000001', '60400000-0000-4000-8000-00000000000a',
        '60200000-0000-4000-8000-00000000000a', 1, 40.00);
-- …e baixa o estoque FISICAMENTE, como `baixar_estoque_organizacao` faz.
update public.produtos set estoque = estoque - 1 where id = '60200000-0000-4000-8000-00000000000a';

select is(
    (select estoque || '/' || estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000a'),
    '1/0',
    '1. venda manual: baixa física de 1, nenhuma reserva — disponibilidade caiu exatamente 1'
);

-- O `order.created` chega e sincroniza a situação do Bling: a MESMA linha
-- volta para `Pendente`. É o `upsert` de `pedidoRepository`.
update public.pedidos set status = 'Pendente', numero = '21'
 where bling_id = '26801269702';

select is(
    (select estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000a'),
    0,
    '2. webhook devolve a venda manual para Pendente e a reserva NÃO ressuscita'
);

select is(
    (select estoque - estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000a'),
    1,
    '3. disponibilidade final = 1 (era 2, vendeu 1) — o invariante do ticket 30'
);

-- O webhook ainda regrava os itens (`addItems`). Mesmo produto, mesma
-- quantidade: não pode virar reserva por ser um UPDATE.
update public.itens_pedido set quantidade = 1
 where pedido_id = '60400000-0000-4000-8000-00000000000a';

select is(
    (select estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000a'),
    0,
    '4. o `addItems` do webhook sobre a venda manual também não reserva'
);

-- ============================================================================
-- ORDEM 2 — webhook primeiro, venda manual assume a linha (migration 57).
-- ============================================================================
insert into public.pedidos (id, user_id, cliente_id, bling_id, numero, total, status, origem)
values ('60400000-0000-4000-8000-00000000000b', '60000000-0000-4000-8000-000000000001',
        '60300000-0000-4000-8000-00000000000a', '26801269703', '22', 40.00, 'Pendente', 'Bling');
insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('60000000-0000-4000-8000-000000000001', '60400000-0000-4000-8000-00000000000b',
        '60200000-0000-4000-8000-00000000000b', 1, 40.00);

select is(
    (select estoque || '/' || estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000b'),
    '2/1',
    '5. webhook primeiro: o pedido do Bling reserva, como sempre reservou'
);

-- A venda manual assume a linha: origem vira manual, status vira Entregue, e
-- o estoque sai fisicamente.
update public.pedidos set status = 'Entregue', origem = 'Loja Física / Manual'
 where id = '60400000-0000-4000-8000-00000000000b';
update public.produtos set estoque = estoque - 1 where id = '60200000-0000-4000-8000-00000000000b';

select is(
    (select estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000b'),
    0,
    '6. a tomada da linha LIBERA a reserva que o webhook criou — sem reserva fantasma presa'
);

select is(
    (select estoque - estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000b'),
    1,
    '7. …e a disponibilidade também caiu exatamente 1 nesta ordem'
);

-- ============================================================================
-- REGRESSÃO — a sincronização legítima de status do Bling continua valendo
-- para pedido que NÃO é venda manual.
-- ============================================================================
insert into public.pedidos (id, user_id, cliente_id, bling_id, numero, total, status, origem)
values ('60400000-0000-4000-8000-00000000000c', '60000000-0000-4000-8000-000000000001',
        '60300000-0000-4000-8000-00000000000a', '26801269704', '23', 40.00, 'Pendente', 'Bling');
insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('60000000-0000-4000-8000-000000000001', '60400000-0000-4000-8000-00000000000c',
        '60200000-0000-4000-8000-00000000000c', 2, 40.00);

update public.pedidos set status = 'Entregue' where id = '60400000-0000-4000-8000-00000000000c';
select is(
    (select estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000c'),
    0,
    '8. pedido do Bling entregue: libera a reserva (inalterado)'
);

update public.pedidos set status = 'Pendente' where id = '60400000-0000-4000-8000-00000000000c';
select is(
    (select estoque_reservado from public.produtos where id = '60200000-0000-4000-8000-00000000000c'),
    2,
    '9. pedido do Bling reaberto: RE-reserva — a correção não desligou a sincronização legítima'
);

select * from finish();
rollback;
