-- catalogo_organizacao.test.sql
-- Ticket 26: Migrar catálogo de produtos e categorias para a organização

begin;

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

insert into auth.users (id, email)
values ('97000000-0000-4000-8000-000000000001', 'owner-catalog@orbita.test'),
       ('97000000-0000-4000-8000-000000000002', 'collab-catalog@orbita.test'),
       ('97000000-0000-4000-8000-000000000003', 'stranger-catalog@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/22_migrar_catalogo_organizacao.sql

select plan(7);

-- 1. Owner cria organização
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000001';

create temp table temp_org as
select public.criar_organizacao_atomica('Empresa Catalogo', 'empresa-catalogo') as org_id;

-- 2. Associar colaborador como membro da organização (como postgres)
set local role postgres;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org), '97000000-0000-4000-8000-000000000002'::uuid, 'member');

-- 3. Inserir produto pelo Owner (trigger deve preencher organizacao_id automaticamente)
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000001';
insert into public.produtos (id, user_id, bling_id, nome, preco, estoque)
values ('97100000-0000-4000-8000-000000000001', '97000000-0000-4000-8000-000000000001', 'prod-cat-1', 'Camiseta Polo', 89.90, 50);

select is(
    (select organizacao_id from public.produtos where id = '97100000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org),
    'Trigger auto-preencheu organizacao_id no produto a partir da membership do owner'
);

-- 4. Inserir categoria pelo Owner
insert into public.categorias (id, user_id, descricao, bling_id)
values ('97200000-0000-4000-8000-000000000001', '97000000-0000-4000-8000-000000000001', 'Vestuario', 'cat-100');

select is(
    (select organizacao_id from public.categorias where id = '97200000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org),
    'Trigger auto-preencheu organizacao_id na categoria a partir da membership do owner'
);

-- 5. Colaborador autenticado acessa e edita o produto da organização (RLS)
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000002';

select is(
    (select count(*) from public.produtos where id = '97100000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Colaborador membro da organizacao consegue ler produto do catalogo compartilhado'
);

update public.produtos
set preco = 99.90
where id = '97100000-0000-4000-8000-000000000001'::uuid;

select is(
    (select preco from public.produtos where id = '97100000-0000-4000-8000-000000000001'::uuid),
    99.90,
    'Colaborador membro da organizacao consegue atualizar produto do catalogo'
);

-- 6. Estranho (outro tenant) tenta acessar o produto e a categoria (RLS deve bloquear)
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-4000-8000-000000000003';

select is(
    (select count(*) from public.produtos where id = '97100000-0000-4000-8000-000000000001'::uuid),
    0::bigint,
    'Usuario de outro tenant nao enxerga produtos da organizacao alheia via RLS'
);

select is(
    (select count(*) from public.categorias where id = '97200000-0000-4000-8000-000000000001'::uuid),
    0::bigint,
    'Usuario de outro tenant nao enxerga categorias da organizacao alheia via RLS'
);

-- 7. Testar procedimento de backfill
set local role postgres;
select lives_ok(
    $$select public.migrar_catalogo_para_organizacoes()$$,
    'Procedimento migrar_catalogo_para_organizacoes executa sem erros'
);

select * from finish();
rollback;
