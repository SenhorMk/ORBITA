-- titulo_financeiro_vinculado_ao_pedido.test.sql
-- Fatia P0 de coerência financeira: pedido cancelado não continua como receita
-- ativa, e nada é apagado.
--
-- REINTRODUZIR O DEFEITO: remova o gatilho
-- `tg_pedidos_converge_titulos_cancelados` da migration 61. As asserções 3 a 6
-- falham — o título segue `pago` sobre um pedido cancelado.

begin;

create table public.clientes (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    organizacao_id uuid not null,
    nome    text not null
);

create table public.pedidos (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid references auth.users(id) on delete cascade,
    organizacao_id uuid not null,
    cliente_id     uuid not null references public.clientes(id) on delete restrict,
    bling_id       text,
    numero         text,
    total          numeric(12,2) not null default 0.00,
    status         text not null default 'Pendente',
    origem         text not null default 'Bling',
    constraint uq_pedidos_org_bling unique (organizacao_id, bling_id)
);

create table public.titulos_financeiros (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    organizacao_id  uuid not null,
    tipo            text not null check (tipo in ('receber', 'pagar')),
    situacao        text not null default 'aberto',
    valor           numeric(12,2) not null,
    data_vencimento date,
    data_pagamento  date,
    descricao       text,
    created_at      timestamptz not null default now()
);

insert into auth.users (id, email) values ('61000000-0000-4000-8000-000000000001', 'owner-t61@orbita.test');

-- A migration REAL, e não uma cópia dela. Copiar o gatilho para dentro do
-- teste faria o teste passar mesmo se a migration perdesse o gatilho — que é
-- exatamente o defeito que ele existe para pegar.
\ir ../../../database/61_titulo_financeiro_vinculado_ao_pedido.sql

insert into public.clientes (id, user_id, organizacao_id, nome)
values ('61300000-0000-4000-8000-00000000000a', '61000000-0000-4000-8000-000000000001',
        '61100000-0000-4000-8000-00000000000a', 'Cliente T61');

select plan(11);

-- ============================================================================
-- VÍNCULO
-- ============================================================================
insert into public.pedidos (id, user_id, organizacao_id, cliente_id, bling_id, numero, total, status, origem)
values ('61400000-0000-4000-8000-00000000000a', '61000000-0000-4000-8000-000000000001',
        '61100000-0000-4000-8000-00000000000a', '61300000-0000-4000-8000-00000000000a',
        '900', 'A', 40.00, 'Entregue', 'Loja Física / Manual');

insert into public.titulos_financeiros (user_id, organizacao_id, pedido_id, tipo, situacao, valor, descricao)
values ('61000000-0000-4000-8000-000000000001', '61100000-0000-4000-8000-00000000000a',
        '61400000-0000-4000-8000-00000000000a', 'receber', 'pago', 40.00, 'Venda manual 900');

select is(
    (select count(*)::int from public.titulos_financeiros where pedido_id = '61400000-0000-4000-8000-00000000000a'),
    1,
    '1. a venda grava o título já vinculado ao pedido'
);

select throws_ok(
    $q$insert into public.titulos_financeiros (user_id, organizacao_id, pedido_id, tipo, situacao, valor)
       values ('61000000-0000-4000-8000-000000000001', '61100000-0000-4000-8000-00000000000b',
               '61400000-0000-4000-8000-00000000000a', 'receber', 'pago', 40.00)$q$,
    '23503',
    null,
    '2. título de OUTRA organização não pode apontar para este pedido — a FK é composta'
);

select throws_ok(
    $q$insert into public.titulos_financeiros (user_id, organizacao_id, pedido_id, tipo, situacao, valor)
       values ('61000000-0000-4000-8000-000000000001', '61100000-0000-4000-8000-00000000000a',
               '61400000-0000-4000-8000-00000000000a', 'receber', 'pago', 40.00)$q$,
    '23505',
    null,
    '3. o mesmo pedido não gera um segundo título a receber'
);

-- ============================================================================
-- CANCELAMENTO
-- ============================================================================
update public.pedidos set status = 'Cancelado' where id = '61400000-0000-4000-8000-00000000000a';

select is(
    (select situacao from public.titulos_financeiros where pedido_id = '61400000-0000-4000-8000-00000000000a'),
    'estornado',
    '4. título PAGO de pedido cancelado vira `estornado` — a venda foi revertida'
);

select is(
    (select count(*)::int from public.titulos_financeiros where pedido_id = '61400000-0000-4000-8000-00000000000a'),
    1,
    '5. …e continua existindo: o histórico não é apagado'
);

-- Idempotência: a reentrega do cancelamento não pode mexer de novo.
update public.pedidos set status = 'Cancelado' where id = '61400000-0000-4000-8000-00000000000a';
update public.pedidos set status = 'Cancelado' where id = '61400000-0000-4000-8000-00000000000a';

select is(
    (select situacao from public.titulos_financeiros where pedido_id = '61400000-0000-4000-8000-00000000000a'),
    'estornado',
    '6. repetir o cancelamento é inócuo — nada de estornar duas vezes'
);

-- Título ABERTO segue o outro ramo.
insert into public.pedidos (id, user_id, organizacao_id, cliente_id, bling_id, numero, total, status, origem)
values ('61400000-0000-4000-8000-00000000000b', '61000000-0000-4000-8000-000000000001',
        '61100000-0000-4000-8000-00000000000a', '61300000-0000-4000-8000-00000000000a',
        '901', 'B', 25.00, 'Pendente', 'Bling');
insert into public.titulos_financeiros (user_id, organizacao_id, pedido_id, tipo, situacao, valor)
values ('61000000-0000-4000-8000-000000000001', '61100000-0000-4000-8000-00000000000a',
        '61400000-0000-4000-8000-00000000000b', 'receber', 'aberto', 25.00);

update public.pedidos set status = 'Cancelado' where id = '61400000-0000-4000-8000-00000000000b';

select is(
    (select situacao from public.titulos_financeiros where pedido_id = '61400000-0000-4000-8000-00000000000b'),
    'cancelado',
    '7. título ABERTO de pedido cancelado vira `cancelado` — não houve liquidação a estornar'
);

-- ============================================================================
-- TOTAIS ATIVOS — a mesma soma que `getResumo` faz.
-- ============================================================================
select is(
    (select coalesce(sum(valor), 0)::numeric from public.titulos_financeiros
      where organizacao_id = '61100000-0000-4000-8000-00000000000a'
        and tipo = 'receber' and situacao = 'pago'),
    0::numeric,
    '8. nenhum terminal entra em Total Entradas'
);

-- ============================================================================
-- TROCA: cancelar A (R$ 40) e criar B (R$ 60) — receita ativa = R$ 60.
-- ============================================================================
insert into public.pedidos (id, user_id, organizacao_id, cliente_id, bling_id, numero, total, status, origem)
values ('61400000-0000-4000-8000-00000000000c', '61000000-0000-4000-8000-000000000001',
        '61100000-0000-4000-8000-00000000000a', '61300000-0000-4000-8000-00000000000a',
        '902', 'C', 60.00, 'Entregue', 'Loja Física / Manual');
insert into public.titulos_financeiros (user_id, organizacao_id, pedido_id, tipo, situacao, valor)
values ('61000000-0000-4000-8000-000000000001', '61100000-0000-4000-8000-00000000000a',
        '61400000-0000-4000-8000-00000000000c', 'receber', 'pago', 60.00);

select is(
    (select coalesce(sum(valor), 0)::numeric from public.titulos_financeiros
      where organizacao_id = '61100000-0000-4000-8000-00000000000a'
        and tipo = 'receber' and situacao = 'pago'),
    60.00::numeric,
    '9. troca: A de R$ 40 estornada + B de R$ 60 válida = receita ativa R$ 60, não R$ 100'
);

select is(
    (select count(*)::int from public.titulos_financeiros
      where organizacao_id = '61100000-0000-4000-8000-00000000000a' and tipo = 'receber'),
    3,
    '10. …e os três acontecimentos continuam no histórico'
);

select throws_ok(
    $q$update public.titulos_financeiros set situacao = 'inventado'
        where pedido_id = '61400000-0000-4000-8000-00000000000c'$q$,
    '23514',
    null,
    '11. um quinto estado não escapa das métricas por digitação — o domínio é fechado'
);

select * from finish();
rollback;
