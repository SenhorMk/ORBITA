-- foto_personalizada_do_produto.test.sql
-- Migration 70: `produtos.imagem_storage_path`, separada do espelho do Bling
-- (`imagem_url`) e presa ao prefixo `<organizacao_id>/<produto_id>/` da
-- própria linha.

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
    imagem_url        text,
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
values ('f7000000-0000-4000-8000-000000000001', 'owner-t70@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/22_migrar_catalogo_organizacao.sql
\ir ../../../database/23_migrar_comercial_estoque_fiscal.sql
\ir ../../../database/70_foto_personalizada_do_produto.sql

insert into public.organizacoes (id, nome, slug) values
    ('f7100000-0000-4000-8000-000000000001', 'Org A T70', 'org-a-t70'),
    ('f7100000-0000-4000-8000-000000000002', 'Org B T70', 'org-b-t70');

insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, imagem_url) values
    ('f7200000-0000-4000-8000-00000000000a', 'f7000000-0000-4000-8000-000000000001',
     'f7100000-0000-4000-8000-000000000001', '70001', 'Produto A', 'https://bling/a.jpg'),
    ('f7200000-0000-4000-8000-00000000000b', 'f7000000-0000-4000-8000-000000000001',
     'f7100000-0000-4000-8000-000000000001', '70002', 'Produto A2', null);

select plan(12);

select has_column('public', 'produtos', 'imagem_storage_path', '1. produtos.imagem_storage_path existe');
select col_type_is('public', 'produtos', 'imagem_storage_path', 'text', '2. o caminho é texto');
select col_is_null('public', 'produtos', 'imagem_storage_path', '3. a coluna é opcional — produto sem foto do ORBITA é o caso comum');

select lives_ok(
    $$update public.produtos
         set imagem_storage_path = 'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'
       where id = 'f7200000-0000-4000-8000-00000000000a'$$,
    '4. caminho no prefixo da própria linha é aceito'
);

select throws_ok(
    $$update public.produtos
         set imagem_storage_path = 'f7100000-0000-4000-8000-000000000002/f7200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'
       where id = 'f7200000-0000-4000-8000-00000000000a'$$,
    '23514', null,
    '5. caminho com a organização de outro tenant é recusado pelo banco'
);

select throws_ok(
    $$update public.produtos
         set imagem_storage_path = 'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'
       where id = 'f7200000-0000-4000-8000-00000000000b'$$,
    '23514', null,
    '6. caminho de outro produto da mesma organização é recusado'
);

select throws_ok(
    $$update public.produtos
         set imagem_storage_path = 'https://x.supabase.co/storage/v1/object/sign/produto-imagens/a.png?token=eyJ'
       where id = 'f7200000-0000-4000-8000-00000000000b'$$,
    '23514', null,
    '7. URL assinada nunca é persistida'
);

select throws_ok(
    $$update public.produtos
         set imagem_storage_path = 'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000b/../f7200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'
       where id = 'f7200000-0000-4000-8000-00000000000b'$$,
    '23514', null,
    '8. travessia de diretório é recusada'
);

-- O compare-and-set que `ProdutoImagemRepository.trocarCaminho` emite. Um
-- `WITH ... UPDATE` dentro de uma expressão não é aceito pelo Postgres
-- (0A000), então cada `UPDATE` roda como instrução e a asserção confere que a
-- foto ficou onde estava.

-- 9. Precondição desatualizada: a linha tem A, o CAS espera B.
update public.produtos
   set imagem_storage_path = 'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000a/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp'
 where id = 'f7200000-0000-4000-8000-00000000000a'
   and organizacao_id = 'f7100000-0000-4000-8000-000000000001'
   and imagem_storage_path = 'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000a/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png';

select is(
    (select imagem_storage_path from public.produtos where id = 'f7200000-0000-4000-8000-00000000000a'),
    'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
    '9. CAS com precondição desatualizada não troca nada'
);

-- 10. Precondição certa, organização errada.
update public.produtos
   set imagem_storage_path = null
 where id = 'f7200000-0000-4000-8000-00000000000a'
   and organizacao_id = 'f7100000-0000-4000-8000-000000000002'
   and imagem_storage_path = 'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';

select is(
    (select imagem_storage_path from public.produtos where id = 'f7200000-0000-4000-8000-00000000000a'),
    'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
    '10. CAS escopado por outra organização não alcança a linha'
);

-- A sincronização grava o espelho do Bling sem mencionar a foto.
update public.produtos set imagem_url = 'https://bling/a-nova.jpg', nome = 'Produto A (Bling)'
 where id = 'f7200000-0000-4000-8000-00000000000a';

select is(
    (select imagem_storage_path from public.produtos where id = 'f7200000-0000-4000-8000-00000000000a'),
    'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
    '11. regravar imagem_url pela sincronização não toca a foto do ORBITA'
);

select lives_ok(
    $$update public.produtos set imagem_storage_path = null where id = 'f7200000-0000-4000-8000-00000000000a'$$,
    '12. remover a foto (null) é sempre aceito'
);

select * from finish();
rollback;
