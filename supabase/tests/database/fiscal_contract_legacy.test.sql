-- fiscal_contract_legacy.test.sql
-- Ticket 20: Contrair o modelo fiscal legado

begin;

-- Fixtures descartáveis
create table public.pedidos (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid references auth.users(id) on delete cascade,
    numero     text not null
);

create table public.nfes (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references auth.users(id) on delete cascade,
    bling_id     text not null,
    numero       text not null,
    chave        text,
    status       text not null,
    pedido_id    uuid not null references public.pedidos(id) on delete cascade,
    emitida_em   timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create table public.nfe (
    id uuid primary key default gen_random_uuid()
);

insert into auth.users (id, email)
values ('69000000-0000-4000-8000-000000000001', 'tenant-contract@orbita.test');

insert into public.pedidos (id, user_id, numero)
values ('69100000-0000-4000-8000-000000000001', '69000000-0000-4000-8000-000000000001', 'PED-901');

insert into public.nfes (
    id, user_id, bling_id, numero, chave, status, pedido_id, emitida_em
) values (
    '69200000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001',
    'BLING-901',
    '901',
    'CHAVE-901',
    'Emitida',
    '69100000-0000-4000-8000-000000000001',
    now()
);

\ir .generated/14_expand_modelo_fiscal_canonico.inc
\ir .generated/15_migrar_dados_e_callers_fiscais.inc
\ir .generated/16_contrair_modelo_fiscal_legado.inc

select plan(5);

-- 1. Verificar que a tabela canônica documentos_fiscais existe
select has_table('public', 'documentos_fiscais', 'Tabela canônica documentos_fiscais deve existir');

-- 2. Verificar que as tabelas legadas e drift foram removidas
select hasnt_table('public', 'nfes', 'Tabela legada nfes deve ter sido removida na contração');
select hasnt_table('public', 'nfe', 'Tabela drift órfã nfe deve ter sido removida na contração');

-- 3. Verificar que os dados históricos continuam preservados na tabela canônica
select is(
    (select count(*) from public.documentos_fiscais where id = '69200000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Registro fiscal histórico continua perfeitamente preservado em documentos_fiscais'
);

-- 4. RLS ativa na tabela canônica
select is(
    (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'documentos_fiscais'),
    true,
    'documentos_fiscais deve ter RLS habilitada'
);

select * from finish();
rollback;
