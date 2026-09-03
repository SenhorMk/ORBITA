-- migration_58_invariantes_de_reserva.test.sql
-- Ticket 30, fatia 4 — a migration 58 muda dois gatilhos COMPARTILHADOS
-- (`fn_atualizar_estoque_reservado`, `fn_atualizar_reserva_status_pedido`),
-- não uma função exclusiva da venda manual. "O webhook não muda de
-- comportamento" não é afirmação que se sustente sem provar: qualquer pedido
-- que passe por esses gatilhos — venda manual OU importado do Bling — está
-- sujeito à regra nova.
--
-- Este teste usa `INSERT`/`UPDATE`/`DELETE` diretos em `pedidos` e
-- `itens_pedido` — exatamente o que `pedidoRepository.upsert` e
-- `pedidoRepository.addItems` fazem no caminho do WEBHOOK. Nenhuma chamada a
-- `registrar_venda_manual` aqui: é o caminho que a fatia 3 do PR #72
-- classificou como "sem mudança de comportamento" — este teste troca a
-- afirmação por prova.
--
-- A matriz cobre as seis transições pedidas na revisão, numa caminhada única
-- e coerente sobre um só pedido (mais barato que seis cenários isolados, e
-- mostra a mesma linha atravessando o ciclo de vida inteiro):
--
--   1. Pendente -> Entregue                  (webhook entrega um pedido)
--   2. Entregue -> Cancelado                 (final -> final, no-op)
--   3. Entregue -> Pendente                  (reversão — nada no schema proíbe)
--   4. Cancelado -> Pendente                 (reabertura — nada no schema proíbe)
--   5. item inserido num pedido já Entregue  (não reserva)
--   6. item apagado de um pedido já Entregue (não mexe na reserva)
--
-- Nenhuma dessas transições é bloqueada por CHECK constraint nem por trigger
-- BEFORE nesta suíte — `status` é `text` livre. Não há "transição proibida"
-- para demonstrar como impossível; todas são alcançáveis pelo código real
-- (`mapBlingStatus` decide o valor que o webhook grava, sem restrição).
--
-- REINTRODUZIR O DEFEITO: troque o `\ir` da migration 58 por nada. As
-- asserções 1, 3, 6, 8 e 10 (as que dependem da liberação/re-reserva em
-- `Entregue`) falham — a maioria fica presa em 3 (nunca libera) e a 8 fica
-- negativa (libera reserva que nunca existiu).

begin;

create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              text,
    nome                  text not null,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
    bling_id          text,
    nome              text not null,
    preco             numeric(10,2) not null default 0,
    estoque           integer not null default 100,
    estoque_reservado integer not null default 0,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create table public.pedidos (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    bling_id        text,
    numero          text,
    data            timestamptz not null default now(),
    cliente_id      uuid not null references public.clientes(id) on delete restrict,
    total           numeric(12,2) not null default 0.00,
    status          text not null default 'Pendente',
    origem          text not null default 'Bling',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table public.itens_pedido (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    pedido_id       uuid not null references public.pedidos(id) on delete cascade,
    produto_id      uuid not null references public.produtos(id) on delete restrict,
    quantidade      int not null default 1,
    valor_unitario  numeric(12,2) not null default 0.00,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint unq_item_pedido_produto unique (pedido_id, produto_id)
);

insert into auth.users (id, email)
values ('58000000-0000-4000-8000-000000000001', 'owner-t58@orbita.test');

-- Só as migrations de que os dois gatilhos dependem: nenhuma organização,
-- nenhuma venda manual — este teste não afirma nada sobre elas.
\ir ../../../database/58_reserva_nao_conta_pedido_finalizado.sql

-- Ligações reais, as MESMAS de `supabase/lab/00_bootstrap_schema.sql` —
-- webhook e venda manual compartilham os dois gatilhos por essas ligações.
create trigger tg_atualizar_estoque_reservado
after insert or update or delete on itens_pedido for each row execute function fn_atualizar_estoque_reservado();

create trigger tg_pedidos_reserva_status
after update of status on pedidos for each row execute function fn_atualizar_reserva_status_pedido();

insert into public.clientes (id, user_id, nome)
values ('58300000-0000-4000-8000-00000000000a', '58000000-0000-4000-8000-000000000001', 'Cliente T58');

insert into public.produtos (id, user_id, nome)
values
    ('58200000-0000-4000-8000-00000000000a', '58000000-0000-4000-8000-000000000001', 'Produto P'),
    ('58200000-0000-4000-8000-00000000000b', '58000000-0000-4000-8000-000000000001', 'Produto Q');

-- O pedido nasce Pendente — exatamente como `pedidoRepository.upsert` grava
-- na primeira sincronização de um pedido novo vindo do Bling.
insert into public.pedidos (id, user_id, cliente_id, bling_id, numero, total, status, origem)
values ('58400000-0000-4000-8000-00000000000a', '58000000-0000-4000-8000-000000000001',
        '58300000-0000-4000-8000-00000000000a', '777', '1', 30.00, 'Pendente', 'Bling');

select plan(11);

-- ----------------------------------------------------------------------------
-- Estado inicial: item do produto P entra num pedido Pendente. Reserva sobe —
-- comportamento nunca mudado por esta migration, é a base de comparação.
-- ----------------------------------------------------------------------------
insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('58000000-0000-4000-8000-000000000001', '58400000-0000-4000-8000-00000000000a',
        '58200000-0000-4000-8000-00000000000a', 3, 10.00);

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000a'),
    3,
    'base: item num pedido Pendente reserva a quantidade — inalterado pela migration 58'
);

-- ----------------------------------------------------------------------------
-- 1. Pendente -> Entregue (webhook entrega o pedido; NENHUMA venda manual
--    envolvida). A reserva de P precisa ser liberada.
-- ----------------------------------------------------------------------------
update public.pedidos set status = 'Entregue' where id = '58400000-0000-4000-8000-00000000000a';

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000a'),
    0,
    '1. Pendente -> Entregue pelo WEBHOOK (sem venda manual) libera a reserva — a mesma regra da fatia 2 se aplica aqui'
);

-- ----------------------------------------------------------------------------
-- 5. Item inserido num pedido JÁ Entregue (produto Q) não reserva nada.
-- ----------------------------------------------------------------------------
insert into public.itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
values ('58000000-0000-4000-8000-000000000001', '58400000-0000-4000-8000-00000000000a',
        '58200000-0000-4000-8000-00000000000b', 2, 15.00);

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000b'),
    0,
    '5. item inserido num pedido já Entregue não reserva — o pedido já está resolvido, não pendente'
);

-- ----------------------------------------------------------------------------
-- 6. Item de P apagado do pedido (ainda Entregue) não mexe na reserva de P —
--    ela já estava em 0, e tem de continuar em 0, não ir a negativo.
-- ----------------------------------------------------------------------------
delete from public.itens_pedido
where pedido_id = '58400000-0000-4000-8000-00000000000a'
  and produto_id = '58200000-0000-4000-8000-00000000000a';

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000a'),
    0,
    '6. apagar item de um pedido já Entregue não mexe na reserva — nunca foi contabilizada'
);

-- ----------------------------------------------------------------------------
-- 2. Entregue -> Cancelado: final -> final. Nenhum dos dois lados reservava
--    (P está sem item, Q nunca reservou) — nada deve mudar.
-- ----------------------------------------------------------------------------
update public.pedidos set status = 'Cancelado' where id = '58400000-0000-4000-8000-00000000000a';

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000a'),
    0,
    '2a. Entregue -> Cancelado (final -> final) não mexe na reserva de P'
);

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000b'),
    0,
    '2b. Entregue -> Cancelado (final -> final) não mexe na reserva de Q'
);

-- ----------------------------------------------------------------------------
-- 4. Cancelado -> Pendente: reabertura. Nada no schema a proíbe — o Bling
--    pode reportar um pedido "descancelado", e o webhook reflete o que
--    reportar. Re-reserva pelos itens ATUAIS (só Q, com quantidade 2).
-- ----------------------------------------------------------------------------
update public.pedidos set status = 'Pendente' where id = '58400000-0000-4000-8000-00000000000a';

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000b'),
    2,
    '4. Cancelado -> Pendente (reabertura) re-reserva pelos itens atuais — só Q existe, com quantidade 2'
);

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000a'),
    0,
    '4b. …e P continua em 0 — não existe item dele no pedido para reservar'
);

-- Fecha o ciclo de volta a Entregue, para a próxima transição partir de um
-- estado conhecido: reserva de Q liberada de novo.
update public.pedidos set status = 'Entregue' where id = '58400000-0000-4000-8000-00000000000a';

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000b'),
    0,
    'fecha o ciclo: Pendente -> Entregue de novo libera a reserva de Q — idempotente, não acumula'
);

-- ----------------------------------------------------------------------------
-- 3. Entregue -> estado NÃO final que não é Cancelado (aqui, Pendente de
--    novo). Nada no schema proíbe: o Bling pode reportar um pedido entregue
--    como pendente de novo (ex.: reversão de status na conta). Re-reserva.
-- ----------------------------------------------------------------------------
update public.pedidos set status = 'Pendente' where id = '58400000-0000-4000-8000-00000000000a';

select is(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000b'),
    2,
    '3. Entregue -> Pendente (reversão) re-reserva pelos itens atuais'
);

-- ----------------------------------------------------------------------------
-- Guarda de não-regressão: em nenhum momento a reserva foi negativa. Uma
-- reserva negativa não significa nada e contaminaria a próxima venda do
-- mesmo produto — é o tipo de defeito que só aparece numa transição que este
-- teste não cobrisse.
-- ----------------------------------------------------------------------------
select ok(
    (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000a') >= 0
    and (select estoque_reservado from public.produtos where id = '58200000-0000-4000-8000-00000000000b') >= 0,
    'em nenhum ponto da caminhada a reserva foi negativa'
);

select * from finish();
rollback;
