-- checkpoint_de_sync_por_organizacao.test.sql
--
-- Invariante sob teste: o checkpoint de sincronização é identificado por
-- `(organizacao_id, entidade)`. O mesmo ator pode ter checkpoint da MESMA
-- entidade em organizações diferentes, e reexecutar uma organização não move a
-- outra.
--
-- REINTRODUZIR O DEFEITO: troque o `\ir` da migration 65 por nada. A primária
-- histórica `(user_id, entidade)` volta e a asserção 2 falha com violação de
-- chave única.

begin;

create table public.organizacoes (
    id   uuid primary key default gen_random_uuid(),
    nome text not null,
    slug text not null unique
);

-- O esqueleto de `sync_state` como as migrations 32 e 55 o deixaram: primária
-- histórica por ator, `organizacao_id` acrescentado depois e ainda nulável, e
-- o índice único total por organização que a 55 criou.
create table public.sync_state (
    user_id        uuid not null references auth.users(id) on delete cascade,
    entidade       text not null,
    last_synced_at timestamptz,
    updated_at     timestamptz not null default now(),
    organizacao_id uuid references public.organizacoes(id) on delete cascade,
    primary key (user_id, entidade)
);

create unique index uq_sync_state_org_entidade on public.sync_state (organizacao_id, entidade);

insert into auth.users (id, email) values ('65000000-0000-4000-8000-000000000001', 'ator-t65@orbita.test');

insert into public.organizacoes (id, nome, slug) values
    ('65100000-0000-4000-8000-00000000000a', 'Org A', 'org-a-t65'),
    ('65100000-0000-4000-8000-00000000000b', 'Org B', 'org-b-t65');

\ir ../../../database/65_checkpoint_de_sync_por_organizacao.sql

select plan(8);

-- ============================================================================
-- A chave passou a ser a de tenancy, e o ator deixou de ser chave.
-- ============================================================================
select is(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.sync_state'::regclass and contype = 'p'),
    'PRIMARY KEY (organizacao_id, entidade)',
    '1. a primária de sync_state é (organizacao_id, entidade)'
);

-- ============================================================================
-- O caso que a primária histórica recusava: MESMO ator, MESMA entidade, duas
-- organizações.
-- ============================================================================
insert into public.sync_state (organizacao_id, user_id, entidade, last_synced_at)
values ('65100000-0000-4000-8000-00000000000a', '65000000-0000-4000-8000-000000000001',
        'financeiro_contas_pagar', '2026-09-01T00:00:00Z');

select lives_ok(
    $$insert into public.sync_state (organizacao_id, user_id, entidade, last_synced_at)
      values ('65100000-0000-4000-8000-00000000000b', '65000000-0000-4000-8000-000000000001',
              'financeiro_contas_pagar', '2026-09-02T00:00:00Z')$$,
    '2. o mesmo ator tem checkpoint da mesma entidade em duas organizações'
);

select is(
    (select count(*)::int from public.sync_state where entidade = 'financeiro_contas_pagar'),
    2,
    '3. os dois checkpoints coexistem'
);

-- ============================================================================
-- Reexecução: idempotente por organização, e sem alcançar a outra.
-- ============================================================================
insert into public.sync_state (organizacao_id, user_id, entidade, last_synced_at, updated_at)
values ('65100000-0000-4000-8000-00000000000a', '65000000-0000-4000-8000-000000000001',
        'financeiro_contas_pagar', '2026-09-10T00:00:00Z', now())
on conflict (organizacao_id, entidade)
do update set last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at;

select is(
    (select count(*)::int from public.sync_state where entidade = 'financeiro_contas_pagar'),
    2,
    '4. a reexecução não duplica linha'
);

select is(
    (select last_synced_at from public.sync_state
      where organizacao_id = '65100000-0000-4000-8000-00000000000a' and entidade = 'financeiro_contas_pagar'),
    '2026-09-10T00:00:00Z'::timestamptz,
    '5. a organização reexecutada avançou o próprio marcador'
);

select is(
    (select last_synced_at from public.sync_state
      where organizacao_id = '65100000-0000-4000-8000-00000000000b' and entidade = 'financeiro_contas_pagar'),
    '2026-09-02T00:00:00Z'::timestamptz,
    '6. nenhuma linha da outra organização foi tocada'
);

-- ============================================================================
-- O ator continua obrigatório — e continua sendo só o ator.
-- ============================================================================
select col_not_null('public', 'sync_state', 'user_id', '7. user_id segue obrigatório como ator');
select col_not_null('public', 'sync_state', 'organizacao_id', '8. organizacao_id é obrigatório, como a RLS já exigia');

select * from finish();
rollback;
