-- catalogo_comercial_estoque_fiscal_organizacao.test.sql
-- Ticket 08 (orbita-mvp-producao-v2): produto -> pedido manual -> estoque ->
-- documento fiscal com escopo organizacional verificado (fase EXPAND +
-- BACKFILL: migrations 40 e 41). A fase CONTRACT (migration 42, que torna
-- organizacao_id NOT NULL) e deliberadamente NAO carregada aqui: este teste
-- prova o comportamento de backfill/quarentena que só existe enquanto a
-- coluna ainda aceita NULL para os registros não resolvidos.

begin;

-- Tabelas-base do ciclo comercial reconstruídas como no baseline pré-organização
-- (mesmo padrão usado por supabase/tests/database/comercial_organizacao.test.sql),
-- já que schema_master.sql não é executável isoladamente em banco vazio.
create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              text not null,
    nome                  text not null,
    cpf_cnpj              text,
    email                 text,
    telefone              text,
    telefone_normalizado  text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid references auth.users(id) on delete cascade,
    bling_id          text,
    nome              text not null,
    preco             numeric(10,2) not null default 0,
    estoque           integer not null default 0,
    estoque_reservado integer not null default 0,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create table public.categorias (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid references auth.users(id) on delete cascade,
    bling_id         text,
    descricao        text not null,
    categoria_pai_id text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table public.pedidos (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    bling_id        text not null,
    numero          text not null,
    data            timestamptz not null default now(),
    cliente_id      uuid not null references public.clientes(id) on delete restrict,
    total           numeric(12,2) not null default 0.00,
    frete           numeric(12,2) default 0.00,
    desconto        numeric(12,2) default 0.00,
    status          text not null default 'Pendente',
    origem          text not null default 'Bling',
    forma_pagamento text,
    observacao      text,
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
    updated_at      timestamptz not null default now()
);

create table public.movimentacao_estoque (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references auth.users(id) on delete cascade,
    produto_id   uuid not null references public.produtos(id) on delete cascade,
    tipo         text not null check (tipo in ('ENTRADA', 'SAIDA')),
    origem       text,
    quantidade   int not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create table public.documentos_fiscais (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    pedido_id       uuid references public.pedidos(id) on delete set null,
    bling_id        text,
    tipo            text not null default 'NFE',
    numero          text not null,
    serie           text,
    chave_acesso    text,
    status          text not null default 'Emitida',
    valor_total     numeric(12, 2),
    xml_url         text,
    danfe_url       text,
    emitida_em      timestamptz,
    dados_extras    jsonb,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

insert into auth.users (id, email)
values
    ('99000000-0000-4000-8000-000000000001', 'owner-org-a-t08@orbita.test'),
    ('99000000-0000-4000-8000-000000000002', 'owner-org-b-t08@orbita.test'),
    ('99000000-0000-4000-8000-000000000003', 'orfao-sem-org-t08@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/22_migrar_catalogo_organizacao.sql
\ir ../../../database/23_migrar_comercial_estoque_fiscal.sql
\ir ../../../database/40_expand_verificar_catalogo_comercial_estoque_fiscal.sql
\ir ../../../database/41_backfill_catalogo_comercial_organizacao_contabilizado.sql

insert into public.organizacoes (id, nome, slug) values
    ('99100000-0000-4000-8000-000000000001', 'Organizacao A T08', 'org-a-t08'),
    ('99100000-0000-4000-8000-000000000002', 'Organizacao B T08', 'org-b-t08');

insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('99100000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-000000000001', 'owner'),
    ('99100000-0000-4000-8000-000000000002', '99000000-0000-4000-8000-000000000002', 'owner');

-- Mesmo bling_id nas duas organizacoes, para provar que a unicidade e
-- isolada por organizacao_id e nao colide entre tenants.
insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque) values
    ('99200000-0000-4000-8000-00000000000a', '99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 'SAME-BLING-ID', 'Produto A', 10, 5),
    ('99200000-0000-4000-8000-00000000000b', '99000000-0000-4000-8000-000000000002', '99100000-0000-4000-8000-000000000002', 'SAME-BLING-ID', 'Produto B', 20, 3);

insert into public.clientes (id, user_id, organizacao_id, bling_id, nome) values
    ('99300000-0000-4000-8000-00000000000a', '99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 'SAME-BLING-ID', 'Cliente A'),
    ('99300000-0000-4000-8000-00000000000b', '99000000-0000-4000-8000-000000000002', '99100000-0000-4000-8000-000000000002', 'SAME-BLING-ID', 'Cliente B');

insert into public.pedidos (id, user_id, organizacao_id, bling_id, numero, data, cliente_id, total, status) values
    ('99400000-0000-4000-8000-00000000000a', '99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 'SAME-BLING-ID', '1', now(), '99300000-0000-4000-8000-00000000000a', 10, 'Pendente'),
    ('99400000-0000-4000-8000-00000000000b', '99000000-0000-4000-8000-000000000002', '99100000-0000-4000-8000-000000000002', 'SAME-BLING-ID', '1', now(), '99300000-0000-4000-8000-00000000000b', 20, 'Pendente');

-- Registro orfao (sem nenhuma membership) para provar a quarentena do backfill.
insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque) values
    ('99200000-0000-4000-8000-0000000000ff', '99000000-0000-4000-8000-000000000003', null, 'ORFAO-BLING-ID', 'Produto Orfao', 5, 1);

-- Reexecuta o backfill agora que existem dados de teste (a migration 41 já
-- rodou uma vez, sobre uma base vazia, ao ser expandida acima).
select public.executar_backfill_catalogo_comercial_organizacao();

select plan(12);

-- 1-2: unicidade de bling_id e isolada por organizacao (nao ha colisao entre A e B)
select is(
    (select count(*) from public.produtos where bling_id = 'SAME-BLING-ID'),
    2::bigint,
    'Produtos com o mesmo bling_id coexistem em organizacoes distintas'
);
select is(
    (select organizacao_id from public.produtos where id = '99200000-0000-4000-8000-00000000000a'),
    '99100000-0000-4000-8000-000000000001'::uuid,
    'Produto A permanece vinculado a organizacao A'
);

-- 3: FK composta recusa item de pedido cruzando pedido de A com produto de B
select throws_ok(
    $$insert into public.itens_pedido (user_id, organizacao_id, pedido_id, produto_id, quantidade, valor_unitario)
      values ('99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', '99400000-0000-4000-8000-00000000000a', '99200000-0000-4000-8000-00000000000b', 1, 10)$$,
    '23503',
    null,
    'FK composta recusa item de pedido cujo produto pertence a outra organizacao'
);

-- 4: FK composta recusa item marcado com organizacao diferente da do pedido
select throws_ok(
    $$insert into public.itens_pedido (user_id, organizacao_id, pedido_id, produto_id, quantidade, valor_unitario)
      values ('99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000002', '99400000-0000-4000-8000-00000000000a', '99200000-0000-4000-8000-00000000000a', 1, 10)$$,
    '23503',
    null,
    'FK composta recusa item cuja organizacao nao bate com a do pedido'
);

-- 5: item legitimo dentro da mesma organizacao e aceito
select lives_ok(
    $$insert into public.itens_pedido (user_id, organizacao_id, pedido_id, produto_id, quantidade, valor_unitario)
      values ('99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', '99400000-0000-4000-8000-00000000000a', '99200000-0000-4000-8000-00000000000a', 1, 10)$$,
    'Item de pedido dentro da mesma organizacao e aceito'
);

-- 6: baixar_estoque_organizacao nao aceita organizacao forjada para produto de outra org
select throws_ok(
    $$select public.baixar_estoque_organizacao('99100000-0000-4000-8000-000000000002'::uuid, '99200000-0000-4000-8000-00000000000a'::uuid, 1)$$,
    'P0002',
    null,
    'baixar_estoque_organizacao recusa produto que nao pertence a organizacao informada'
);

-- 7: baixar_estoque_organizacao nunca deixa estoque negativo (falha explicita)
select throws_ok(
    $$select public.baixar_estoque_organizacao('99100000-0000-4000-8000-000000000001'::uuid, '99200000-0000-4000-8000-00000000000a'::uuid, 999)$$,
    '23514',
    null,
    'baixar_estoque_organizacao recusa baixa maior que o estoque disponivel'
);

-- 8: baixa legitima decrementa exatamente a quantidade e registra movimentacao
select is(
    (select estoque_restante from public.baixar_estoque_organizacao('99100000-0000-4000-8000-000000000001'::uuid, '99200000-0000-4000-8000-00000000000a'::uuid, 2)),
    3,
    'baixar_estoque_organizacao decrementa exatamente a quantidade informada'
);
select is(
    (select count(*) from public.movimentacao_estoque where produto_id = '99200000-0000-4000-8000-00000000000a' and origem = 'BAIXA_ORGANIZACAO_VERIFICADA'),
    1::bigint,
    'baixar_estoque_organizacao registra a movimentacao de estoque'
);

-- 9: backfill contabilizado: total = migrados + quarentena, para produtos
select is(
    (select total from public.tenancy_backfill_relatorio where tabela = 'produtos' order by executado_em desc limit 1),
    (select migrados + quarentena from public.tenancy_backfill_relatorio where tabela = 'produtos' order by executado_em desc limit 1),
    'Relatorio de backfill de produtos satisfaz total = migrados + quarentena'
);

-- 10: produto orfao (sem membership) foi para quarentena, nunca atribuido a organizacao alheia
select is(
    (select organizacao_id from public.produtos where id = '99200000-0000-4000-8000-0000000000ff'),
    null::uuid,
    'Produto orfao permanece sem organizacao apos backfill (nunca atribuido ao primeiro usuario)'
);
select is(
    (select motivo from public.tenancy_backfill_quarentena where tabela = 'produtos' and registro_id = '99200000-0000-4000-8000-0000000000ff'),
    'orfao_sem_membership',
    'Produto orfao foi registrado em quarentena com o motivo correto'
);

select * from finish();
rollback;
