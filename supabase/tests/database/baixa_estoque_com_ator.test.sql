-- baixa_estoque_com_ator.test.sql
-- Ticket 09, migration 56.
--
-- `baixar_estoque_organizacao` inseria em `movimentacao_estoque` sem `user_id`,
-- que e NOT NULL. Toda venda manual morria ali — depois de o pedido ja ter sido
-- criado no Bling, deixando um pedido orfao na conta do lojista.

begin;

create table public.clientes (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              text,
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
    codigo            text,
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
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    bling_id   text not null,
    numero     text not null,
    data       timestamptz not null default now(),
    cliente_id uuid not null references public.clientes(id) on delete restrict,
    total      numeric(12,2) not null default 0.00,
    status     text not null default 'Pendente',
    origem     text not null default 'Bling',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.itens_pedido (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid references auth.users(id) on delete cascade,
    pedido_id      uuid not null references public.pedidos(id) on delete cascade,
    produto_id     uuid not null references public.produtos(id) on delete restrict,
    quantidade     int not null default 1,
    valor_unitario numeric(12,2) not null default 0.00,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create table public.movimentacao_estoque (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    produto_id uuid not null references public.produtos(id) on delete cascade,
    tipo       text not null check (tipo in ('ENTRADA', 'SAIDA')),
    origem     text,
    quantidade int not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.documentos_fiscais (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    pedido_id  uuid references public.pedidos(id) on delete set null,
    bling_id   text,
    tipo       text not null default 'NFE',
    numero     text not null,
    status     text not null default 'Emitida',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

insert into auth.users (id, email)
values ('09000000-0000-4000-8000-000000000001', 'owner-t09@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/22_migrar_catalogo_organizacao.sql
\ir ../../../database/23_migrar_comercial_estoque_fiscal.sql
\ir ../../../database/40_expand_verificar_catalogo_comercial_estoque_fiscal.sql
\ir ../../../database/56_baixa_estoque_com_ator.sql

-- `user_id` NOT NULL e a condicao que fazia a insercao falhar; o teste so tem
-- valor com ela no lugar, como esta em producao.
alter table public.movimentacao_estoque alter column user_id set not null;

insert into public.organizacoes (id, nome, slug)
values ('09100000-0000-4000-8000-000000000001', 'Org T09', 'org-t09');

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ('09100000-0000-4000-8000-000000000001', '09000000-0000-4000-8000-000000000001', 'owner');

insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque)
values ('09200000-0000-4000-8000-00000000000a', '09000000-0000-4000-8000-000000000001',
        '09100000-0000-4000-8000-000000000001', '900', 'Rape Pequeno Cravo', 40.00, 3);

select plan(7);

-- ----------------------------------------------------------------------------
-- 1-2. A assinatura antiga saiu e a nova existe.
-- ----------------------------------------------------------------------------
select is(
    to_regprocedure('public.baixar_estoque_organizacao(uuid, uuid, integer)')::text,
    NULL,
    'a assinatura de 3 argumentos saiu — era a unica capaz de reproduzir o defeito'
);

select isnt(
    to_regprocedure('public.baixar_estoque_organizacao(uuid, uuid, integer, uuid)')::text,
    NULL,
    'a assinatura com ator existe'
);

-- ----------------------------------------------------------------------------
-- 3-4. A baixa passa e grava QUEM deu baixa.
-- ----------------------------------------------------------------------------
select lives_ok(
    $baixa$select public.baixar_estoque_organizacao(
        '09100000-0000-4000-8000-000000000001',
        '09200000-0000-4000-8000-00000000000a',
        1,
        '09000000-0000-4000-8000-000000000001')$baixa$,
    'a baixa de estoque por organizacao e aceita — antes morria em user_id NOT NULL'
);

select is(
    (select user_id from public.movimentacao_estoque where produto_id = '09200000-0000-4000-8000-00000000000a'),
    '09000000-0000-4000-8000-000000000001'::uuid,
    'a movimentacao registra o ator que deu a baixa'
);

-- ----------------------------------------------------------------------------
-- 5. O estoque foi debitado de verdade.
-- ----------------------------------------------------------------------------
select is(
    (select estoque from public.produtos where id = '09200000-0000-4000-8000-00000000000a'),
    2,
    'o estoque foi debitado em 1'
);

-- ----------------------------------------------------------------------------
-- 6. Ator ausente e recusado explicitamente, nao por violacao de constraint.
-- ----------------------------------------------------------------------------
select throws_ok(
    $sem_ator$select public.baixar_estoque_organizacao(
        '09100000-0000-4000-8000-000000000001',
        '09200000-0000-4000-8000-00000000000a',
        1,
        NULL)$sem_ator$,
    '22023',
    NULL,
    'ator nulo e recusado com mensagem propria, antes de tocar o banco'
);

-- ----------------------------------------------------------------------------
-- 7. As protecoes da migration 40 continuam valendo.
-- ----------------------------------------------------------------------------
select throws_ok(
    $sem_estoque$select public.baixar_estoque_organizacao(
        '09100000-0000-4000-8000-000000000001',
        '09200000-0000-4000-8000-00000000000a',
        99,
        '09000000-0000-4000-8000-000000000001')$sem_estoque$,
    '23514',
    NULL,
    'estoque insuficiente continua recusado'
);

select * from finish();
rollback;
