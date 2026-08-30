-- produtos_unidade_categoria.test.sql
-- Ticket 12d (orbita-mvp-producao-v2), migration 54.
--
-- `produtos` nunca teve `unidade` nem `categoria_id`, mas o codigo gravava as
-- duas. Cada insert de produto era recusado, o laco de sincronizacao capturava
-- a falha por item e a etapa concluia com zero produtos — "Sincronizado! 0
-- produtos" com o catalogo cheio no Bling.

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
values ('c1000000-0000-4000-8000-000000000001', 'owner-t12d@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/22_migrar_catalogo_organizacao.sql
\ir ../../../database/23_migrar_comercial_estoque_fiscal.sql
\ir ../../../database/54_produtos_unidade_categoria.sql

insert into public.organizacoes (id, nome, slug)
values ('c1100000-0000-4000-8000-000000000001', 'Org T12d', 'org-t12d');

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ('c1100000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'owner');

insert into public.categorias (id, user_id, organizacao_id, bling_id, descricao)
values ('c1400000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000001',
        'c1100000-0000-4000-8000-000000000001', '55', 'Vestuario');

select plan(9);

-- ----------------------------------------------------------------------------
-- 1-4. As colunas que faltavam existem.
-- ----------------------------------------------------------------------------
select has_column('public', 'produtos', 'unidade', 'produtos.unidade existe — sem ela todo insert de produto era recusado');
select has_column('public', 'produtos', 'categoria_id', 'produtos.categoria_id existe');
select has_column('public', 'clientes', 'endereco', 'clientes.endereco existe — o formulario abria sempre vazio sem ela');
select has_column('public', 'clientes', 'indicador_ie', 'clientes.indicador_ie existe (nome real do campo no Bling)');

-- ----------------------------------------------------------------------------
-- 5. O insert que a sincronizacao faz agora passa.
-- ----------------------------------------------------------------------------
select lives_ok(
    $$insert into public.produtos (user_id, organizacao_id, bling_id, codigo, nome, preco, estoque, unidade, categoria_id)
      values ('c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001',
              '77', 'CAM-01', 'Camiseta', 49.90, 10, 'UN', 'c1400000-0000-4000-8000-00000000000a')$$,
    'o insert de produto da sincronizacao, com unidade e categoria, e aceito'
);

-- ----------------------------------------------------------------------------
-- 6. Categoria de outra organizacao e recusada pela FK composta.
-- ----------------------------------------------------------------------------
insert into public.organizacoes (id, nome, slug)
values ('c1100000-0000-4000-8000-000000000002', 'Org B T12d', 'org-b-t12d');

select throws_ok(
    $$insert into public.produtos (user_id, organizacao_id, bling_id, nome, preco, estoque, categoria_id)
      values ('c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000002',
              '78', 'Bone', 29.90, 1, 'c1400000-0000-4000-8000-00000000000a')$$,
    '23503',
    NULL,
    'produto nao pode referenciar categoria de outra organizacao'
);

-- ----------------------------------------------------------------------------
-- 7-9. Restricoes de dominio dos campos novos de cliente.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$insert into public.clientes (user_id, organizacao_id, bling_id, nome, tipo)
      values ('c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', '1', 'X', 'Z')$$,
    '23514',
    NULL,
    'tipo de contato aceita apenas J, F ou E'
);

select throws_ok(
    $$insert into public.clientes (user_id, organizacao_id, bling_id, nome, indicador_ie)
      values ('c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', '2', 'X', 7)$$,
    '23514',
    NULL,
    'indicador_ie aceita apenas 1, 2 ou 9'
);

select throws_ok(
    $$insert into public.clientes (user_id, organizacao_id, bling_id, nome, uf)
      values ('c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', '3', 'X', 'Santa Catarina')$$,
    '23514',
    NULL,
    'uf aceita apenas duas letras'
);

select * from finish();
rollback;
