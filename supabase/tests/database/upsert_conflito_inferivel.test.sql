-- upsert_conflito_inferivel.test.sql
-- Ticket 12e (orbita-mvp-producao-v2), migration 55.
--
-- Todo upsert com escopo de organizacao falhava com 42P10 porque os indices
-- unicos `(organizacao_id, bling_id)` eram PARCIAIS, e o PostgREST nao tem
-- como repetir o predicado do indice na clausula ON CONFLICT que gera.
--
-- O teste faz as duas afirmacoes que importam: o indice nao e mais parcial, e
-- o comando que a aplicacao realmente emite passa a ser aceito.

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

-- A migration 55 atravessa cinco dominios (catalogo, comercial, financeiro,
-- sync_state e chatwoot). Este teste so afirma sobre o catalogo/comercial, que
-- vem das migrations reais 22 e 23 aplicadas abaixo. Os demais dominios
-- entram apenas como esqueleto — as colunas que o indice referencia e nada
-- mais — para que a migration rode inteira sem arrastar as cadeias
-- financeira e de chatwoot para dentro de um teste que nao afirma sobre elas.
-- A aplicacao canonica completa do laboratorio cobre esses dominios de fato.
create table public.sync_state (organizacao_id uuid, entidade text);
create table public.contas_financeiras (organizacao_id uuid, bling_id text);
create table public.categorias_financeiras (organizacao_id uuid, bling_id text);
create table public.fornecedores (organizacao_id uuid, bling_id text);
create table public.titulos_financeiros (organizacao_id uuid, bling_id text);
create table public.chatwoot_inboxes (organizacao_id uuid, conexao_id uuid, inbox_id bigint);
create table public.chatwoot_contacts (organizacao_id uuid, id bigint);
create table public.chatwoot_conversations (organizacao_id uuid, id bigint);
create table public.chatwoot_messages (organizacao_id uuid, id bigint);

insert into auth.users (id, email)
values ('e1000000-0000-4000-8000-000000000001', 'owner-t12e@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/22_migrar_catalogo_organizacao.sql
\ir ../../../database/23_migrar_comercial_estoque_fiscal.sql
\ir ../../../database/55_upsert_conflito_inferivel.sql

insert into public.organizacoes (id, nome, slug)
values ('e1100000-0000-4000-8000-000000000001', 'Org T12e', 'org-t12e');

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'owner');

select plan(8);

-- ----------------------------------------------------------------------------
-- 1-4. Os indices existem e nao sao mais parciais.
--
-- Um indice parcial nunca e inferido por um ON CONFLICT sem predicado, e o
-- PostgREST nunca emite predicado. Parcial aqui == upsert morto.
-- ----------------------------------------------------------------------------
select is(
    (select indpred is null from pg_index where indexrelid = 'public.uq_clientes_org_bling'::regclass),
    true,
    'uq_clientes_org_bling nao e parcial — parcial faz o upsert morrer com 42P10'
);

select is(
    (select indpred is null from pg_index where indexrelid = 'public.uq_produtos_org_bling'::regclass),
    true,
    'uq_produtos_org_bling nao e parcial'
);

select is(
    (select indpred is null from pg_index where indexrelid = 'public.uq_pedidos_org_bling'::regclass),
    true,
    'uq_pedidos_org_bling nao e parcial'
);

select is(
    (select indpred is null from pg_index where indexrelid = 'public.uq_documentos_fiscais_org_bling'::regclass),
    true,
    'uq_documentos_fiscais_org_bling nao e parcial'
);

-- ----------------------------------------------------------------------------
-- 5. O comando exato que o PostgREST gera — sem WHERE — e aceito.
-- ----------------------------------------------------------------------------
select lives_ok(
    $upsert$insert into public.clientes (user_id, organizacao_id, bling_id, nome)
      values ('e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001', '901', 'Contato A')
      on conflict (organizacao_id, bling_id) do update set nome = excluded.nome$upsert$,
    'o upsert de cliente que a sincronizacao emite e aceito'
);

-- ----------------------------------------------------------------------------
-- 6. E e mesmo idempotente: reexecutar atualiza, nao duplica.
-- ----------------------------------------------------------------------------
insert into public.clientes (user_id, organizacao_id, bling_id, nome)
values ('e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001', '901', 'Contato A renomeado')
on conflict (organizacao_id, bling_id) do update set nome = excluded.nome;

select is(
    (select count(*)::int from public.clientes where bling_id = '901'),
    1,
    'reexecutar a sincronizacao atualiza o mesmo contato em vez de duplicar'
);

-- ----------------------------------------------------------------------------
-- 7. A unicidade por organizacao continua valendo.
-- ----------------------------------------------------------------------------
select throws_ok(
    $dup$insert into public.clientes (user_id, organizacao_id, bling_id, nome)
      values ('e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001', '901', 'Duplicata')$dup$,
    '23505',
    NULL,
    'dois contatos com o mesmo bling_id na mesma organizacao continuam proibidos'
);

-- ----------------------------------------------------------------------------
-- 8. E o mesmo bling_id em OUTRA organizacao continua permitido.
-- ----------------------------------------------------------------------------
insert into public.organizacoes (id, nome, slug)
values ('e1100000-0000-4000-8000-000000000002', 'Org B T12e', 'org-b-t12e');

select lives_ok(
    $outra$insert into public.clientes (user_id, organizacao_id, bling_id, nome)
      values ('e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000002', '901', 'Contato de outra org')$outra$,
    'o mesmo bling_id em outra organizacao continua permitido'
);

select * from finish();
rollback;
