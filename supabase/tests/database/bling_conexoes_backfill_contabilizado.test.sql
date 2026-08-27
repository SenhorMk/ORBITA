-- bling_conexoes_backfill_contabilizado.test.sql
-- Ticket 10 (orbita-mvp-producao-v2): backfill contabilizado do vinculo
-- integracoes_bling (legado) -> conexoes_integracao (organizacao),
-- garantindo que casos ambiguos/orfaos vao para quarentena e NUNCA sao
-- atribuidos a "primeira organizacao" encontrada.

begin;

insert into auth.users (id, email)
values ('96000000-0000-4000-8000-000000000001', 'unico-bling@orbita.test'),
       ('96000000-0000-4000-8000-000000000002', 'ambiguo-bling@orbita.test'),
       ('96000000-0000-4000-8000-000000000003', 'orfao-bling@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/25_conexoes_credenciais_privadas.sql

-- Tabelas de quarentena/relatorio de backfill (definidas originalmente na
-- migration 40, cujas demais alteracoes dependem de tabelas de catalogo
-- comercial fora do escopo deste teste isolado — recriadas aqui de forma
-- idempotente e com o schema identico ao da migration 40).
create table if not exists public.tenancy_backfill_quarentena (
    id                bigint generated always as identity primary key,
    tabela            text not null,
    registro_id       uuid not null,
    user_id           uuid,
    motivo            text not null check (motivo in ('orfao_sem_membership', 'ambiguo_multiplas_organizacoes')),
    referencia_hash   text not null,
    detectado_em      timestamptz not null default now(),
    resolvido_em      timestamptz,
    resolvido_por     uuid,
    constraint uq_tenancy_quarentena_registro unique (tabela, registro_id)
);

create table if not exists public.tenancy_backfill_relatorio (
    id              bigint generated always as identity primary key,
    tabela          text not null,
    total           integer not null,
    migrados        integer not null,
    quarentena      integer not null,
    executado_em    timestamptz not null default now(),
    constraint chk_tenancy_relatorio_soma check (total = migrados + quarentena)
);

\ir ../../../database/46_backfill_bling_conexoes_organizacao_contabilizado.sql

select plan(8);

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000001';

create temp table temp_org_unico as
select public.criar_organizacao_atomica('Org Unico Bling', 'org-unico-bling') as org_id;

set local request.jwt.claim.sub = '96000000-0000-4000-8000-000000000002';

create temp table temp_org_ambiguo_a as
select public.criar_organizacao_atomica('Org Ambiguo A', 'org-ambiguo-a') as org_id;

create temp table temp_org_ambiguo_b as
select public.criar_organizacao_atomica('Org Ambiguo B', 'org-ambiguo-b') as org_id;

reset role;

-- O segundo usuario precisa pertencer a DUAS organizacoes (ambiguo). A
-- funcao de criacao atomica so vincula o criador a organizacao que ele
-- criou; inserimos a segunda membership manualmente para simular o caso
-- real de um usuario dono de mais de uma organizacao.
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org_ambiguo_a), '96000000-0000-4000-8000-000000000002', 'owner')
on conflict do nothing;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org_ambiguo_b), '96000000-0000-4000-8000-000000000002', 'owner')
on conflict do nothing;

create table if not exists public.integracoes_bling (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null unique references auth.users(id) on delete cascade,
    client_id        text not null,
    client_secret    text not null,
    access_token     text,
    refresh_token    text,
    token_expires_at timestamptz,
    refresh_locked_at timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

insert into public.integracoes_bling (user_id, client_id, client_secret, access_token, refresh_token)
values
    ('96000000-0000-4000-8000-000000000001', 'client-unico', 'secret-unico', 'access-unico', 'refresh-unico'),
    ('96000000-0000-4000-8000-000000000002', 'client-ambiguo', 'secret-ambiguo', 'access-ambiguo', 'refresh-ambiguo'),
    ('96000000-0000-4000-8000-000000000003', 'client-orfao', 'secret-orfao', null, null);

-- Asserção 1: a execução contabiliza total = migrados + quarentena = 3
select is(
    (select total from public.migrar_bling_conexoes_organizacao_contabilizado() limit 1),
    3,
    'Backfill contabiliza os 3 registros legados elegiveis'
);

-- Asserção 2: exatamente 1 migrado (o caso inequivoco)
select is(
    (select migrados from public.tenancy_backfill_relatorio where tabela = 'integracoes_bling_conexao' order by executado_em desc limit 1),
    1,
    'Exatamente um registro inequivoco foi migrado'
);

-- Asserção 3: exatamente 2 em quarentena (ambiguo + orfao)
select is(
    (select quarentena from public.tenancy_backfill_relatorio where tabela = 'integracoes_bling_conexao' order by executado_em desc limit 1),
    2,
    'Ambiguo e orfao foram enviados para quarentena, nao migrados'
);

-- Asserção 4: a conexao criada para o usuario inequivoco pertence a organizacao correta
select is(
    (select organizacao_id from public.conexoes_integracao
       where provedor = 'bling' and metadata ->> 'migrado_de_user_id' = '96000000-0000-4000-8000-000000000001'),
    (select org_id from temp_org_unico),
    'Conexao Bling do usuario inequivoco foi vinculada a organizacao correta'
);

-- Asserção 5: nenhuma conexao foi criada para o usuario ambiguo (nunca escolhe a "primeira organizacao")
select is(
    (select count(*) from public.conexoes_integracao
       where provedor = 'bling' and metadata ->> 'migrado_de_user_id' = '96000000-0000-4000-8000-000000000002'),
    0::bigint,
    'Nenhuma conexao foi criada automaticamente para o usuario com multiplas organizacoes'
);

-- Asserção 6: o motivo de quarentena do usuário ambíguo é o correto
select is(
    (select motivo from public.tenancy_backfill_quarentena
       where tabela = 'integracoes_bling_conexao'
         and user_id = '96000000-0000-4000-8000-000000000002'),
    'ambiguo_multiplas_organizacoes',
    'Usuario com multiplas organizacoes eh quarentenado com o motivo correto'
);

-- Asserção 7: o motivo de quarentena do usuário órfão é o correto
select is(
    (select motivo from public.tenancy_backfill_quarentena
       where tabela = 'integracoes_bling_conexao'
         and user_id = '96000000-0000-4000-8000-000000000003'),
    'orfao_sem_membership',
    'Usuario sem nenhuma membership eh quarentenado com o motivo correto'
);

-- Asserção 8: reexecucao eh idempotente (nao reprocessa linhas ja migradas/quarentenadas)
select is(
    (select total from public.migrar_bling_conexoes_organizacao_contabilizado() limit 1),
    0,
    'Reexecucao do backfill nao reprocessa linhas ja resolvidas (idempotente)'
);

select * from finish();
rollback;
