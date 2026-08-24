-- fiscal_migration_callers.test.sql
-- Ticket 19: Migrar dados e callers fiscais

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

insert into auth.users (id, email)
values
    ('66000000-0000-4000-8000-000000000001', 'tenant-a@orbita.test'),
    ('66000000-0000-4000-8000-000000000002', 'tenant-b@orbita.test');

insert into public.pedidos (id, user_id, numero)
values
    ('67000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', 'PED-101-A'),
    ('67000000-0000-4000-8000-000000000002', '66000000-0000-4000-8000-000000000002', 'PED-101-B');

\ir .generated/14_expand_modelo_fiscal_canonico.inc
\ir .generated/15_migrar_dados_e_callers_fiscais.inc

select plan(6);

-- 1. Inserir registros legados históricos
insert into public.nfes (
    id, user_id, bling_id, numero, chave, status, pedido_id, emitida_em
) values
    ('68000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', 'BLING-201', '201', 'CHAVE-201', 'Emitida', '67000000-0000-4000-8000-000000000001', now()),
    ('68000000-0000-4000-8000-000000000002', '66000000-0000-4000-8000-000000000002', 'BLING-202', '202', 'CHAVE-202', 'Emitida', '67000000-0000-4000-8000-000000000002', now());

-- 2. Executar procedure de migração de backfill
select * from public.migrar_nfes_para_documentos_fiscais();

-- 3. Verificar equivalência dos dados migrados
select is(
    (select count(*) from public.documentos_fiscais),
    2::bigint,
    'Todos os registros legados foram migrados com sucesso para documentos_fiscais'
);

select is(
    (select chave_acesso from public.documentos_fiscais where id = '68000000-0000-4000-8000-000000000001'::uuid),
    'CHAVE-201',
    'Atributos fiscais foram copiados com precisao no backfill'
);

-- 4. Idempotência do backfill (reexecução não duplica nem quebra)
select * from public.migrar_nfes_para_documentos_fiscais();

select is(
    (select count(*) from public.documentos_fiscais),
    2::bigint,
    'Backfill fiscal eh 100% idempotente'
);

-- 5. Inserção direta de novo documento canônico
insert into public.documentos_fiscais (
    id, user_id, bling_id, numero, chave_acesso, status, tipo
) values (
    '68000000-0000-4000-8000-000000000003',
    '66000000-0000-4000-8000-000000000001',
    'BLING-203',
    '203',
    'CHAVE-203',
    'Emitida',
    'NFE'
);

select is(
    (select count(*) from public.documentos_fiscais where user_id = '66000000-0000-4000-8000-000000000001'::uuid),
    2::bigint,
    'Novas escritas canônicas funcionam perfeitamente'
);

-- 6. Isolamento RLS de leitura
grant select on public.documentos_fiscais to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '66000000-0000-4000-8000-000000000001';

select is(
    (select count(*) from public.documentos_fiscais),
    2::bigint,
    'Tenant A autenticado ve apenas seus proprios documentos fiscais'
);

select is(
    (select count(*) from public.documentos_fiscais where user_id = '66000000-0000-4000-8000-000000000002'::uuid),
    0::bigint,
    'Tenant A nao tem acesso aos documentos fiscais do Tenant B'
);

reset role;

select * from finish();
rollback;
