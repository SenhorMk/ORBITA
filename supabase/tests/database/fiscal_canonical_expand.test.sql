-- fiscal_canonical_expand.test.sql
-- Ticket 18: Expandir o modelo fiscal canônico

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
    ('61000000-0000-4000-8000-000000000001', 'tenant-a@orbita.test'),
    ('61000000-0000-4000-8000-000000000002', 'tenant-b@orbita.test');

insert into public.pedidos (id, user_id, numero)
values
    ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', 'PED-001-A'),
    ('62000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', 'PED-001-B');

\ir .generated/14_expand_modelo_fiscal_canonico.inc

select plan(7);

-- 1. Inserir na tabela legada nfes
insert into public.nfes (
    id, user_id, bling_id, numero, chave, status, pedido_id, emitida_em
) values (
    '63000000-0000-4000-8000-000000000001',
    '61000000-0000-4000-8000-000000000001',
    'NFE-BLING-101',
    '101',
    '35260100000000000000550010000001011000001010',
    'Emitida',
    '62000000-0000-4000-8000-000000000001',
    now()
);

-- 2. Verificar que o trigger propagou para a tabela canônica documentos_fiscais
select is(
    (select count(*) from public.documentos_fiscais where id = '63000000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Trigger de dual-write propagou criacao da NFE legada para documentos_fiscais'
);

select is(
    (select chave_acesso from public.documentos_fiscais where id = '63000000-0000-4000-8000-000000000001'::uuid),
    '35260100000000000000550010000001011000001010',
    'Chave de acesso foi sincronizada corretamente para documentos_fiscais'
);

-- 3. Atualizar status na tabela legada e verificar sincronizacao automatica
update public.nfes
set status = 'Cancelada', updated_at = now()
where id = '63000000-0000-4000-8000-000000000001'::uuid;

select is(
    (select status from public.documentos_fiscais where id = '63000000-0000-4000-8000-000000000001'::uuid),
    'Cancelada',
    'Atualizacao de status na tabela legada foi refletida em documentos_fiscais'
);

-- 4. Tenant B insere documento fiscal com o MESMO bling_id (sem colisao)
insert into public.nfes (
    id, user_id, bling_id, numero, chave, status, pedido_id, emitida_em
) values (
    '63000000-0000-4000-8000-000000000002',
    '61000000-0000-4000-8000-000000000002',
    'NFE-BLING-101',
    '101',
    '35260100000000000000550010000001011000001019',
    'Emitida',
    '62000000-0000-4000-8000-000000000002',
    now()
);

select is(
    (select count(*) from public.documentos_fiscais where bling_id = 'NFE-BLING-101'),
    2::bigint,
    'Dois tenants podem emitir documentos com mesmo bling_id sem colisao'
);

-- 5. RLS: Tenant A autenticado le apenas seu documento fiscal
grant select on public.documentos_fiscais to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '61000000-0000-4000-8000-000000000001';

select is(
    (select count(*) from public.documentos_fiscais),
    1::bigint,
    'Tenant A autenticado ve apenas seus documentos fiscais sob RLS'
);

select is(
    (select id from public.documentos_fiscais limit 1),
    '63000000-0000-4000-8000-000000000001'::uuid,
    'Documento retornado pertence estritamente ao Tenant A'
);

-- 6. RLS: Tentativa de leitura por Tenant B
set local request.jwt.claim.sub = '61000000-0000-4000-8000-000000000002';
select is(
    (select id from public.documentos_fiscais limit 1),
    '63000000-0000-4000-8000-000000000002'::uuid,
    'Tenant B autenticado enxerga seu proprio documento fiscal isolado'
);

reset role;

select * from finish();
rollback;
