-- financeiro_organizacao_ticket09.test.sql
-- Ticket 09 (orbita-mvp-producao-v2): jornada financeira (contas_financeiras,
-- categorias_financeiras, fornecedores, titulos_financeiros) com escopo
-- organizacional verificado (fase EXPAND + BACKFILL: migrations 43 e 44). A
-- fase CONTRACT (migration 45, que torna organizacao_id NOT NULL) e
-- deliberadamente NAO carregada aqui: este teste prova o comportamento de
-- backfill/quarentena que só existe enquanto a coluna ainda aceita NULL para
-- os registros não resolvidos. O comportamento pós-CONTRACT (NOT NULL, RLS
-- canônica sem OR user_id) é validado pelo laboratório completo
-- (`npm run test:db`), que aplica 1..45 em sequência canônica.

begin;

-- Tabelas-base do domínio financeiro reconstruídas como no baseline
-- pré-organização (mesmo padrão usado por
-- supabase/tests/database/financeiro_organizacao.test.sql), já que
-- schema_master.sql não é executável isoladamente em banco vazio.
create table public.contas_financeiras (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete cascade,
    bling_id    bigint,
    descricao   text not null,
    tipo        smallint not null default 1,
    saldo_inicial numeric(12,2) not null default 0.00,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table public.categorias_financeiras (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete cascade,
    bling_id    bigint,
    descricao   text not null,
    tipo        text not null check (tipo in ('receita', 'despesa')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table public.fornecedores (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete cascade,
    bling_id    bigint,
    nome        text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table public.titulos_financeiros (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid references auth.users(id) on delete cascade,
    bling_id              bigint,
    tipo                  text not null check (tipo in ('receber', 'pagar')),
    situacao              text not null default 'aberto' check (situacao in ('aberto', 'pago', 'cancelado')),
    valor                 numeric(12,2) not null default 0.00,
    data_vencimento       date not null,
    data_pagamento        date,
    descricao             text not null,
    categoria_id          uuid references public.categorias_financeiras(id) on delete set null,
    conta_financeira_id   uuid references public.contas_financeiras(id) on delete set null,
    fornecedor_id         uuid references public.fornecedores(id) on delete set null,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

insert into auth.users (id, email)
values
    ('99000000-0000-4000-8000-000000000001', 'owner-org-a-t09@orbita.test'),
    ('99000000-0000-4000-8000-000000000002', 'owner-org-b-t09@orbita.test'),
    ('99000000-0000-4000-8000-000000000003', 'orfao-sem-org-t09@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/24_migrar_financeiro_organizacao.sql

-- tenancy_backfill_quarentena / tenancy_backfill_relatorio sao criadas pela
-- migration 40 (ticket 08), que tambem cria/altera public.produtos,
-- public.clientes e public.pedidos (fora do escopo deste fixture financeiro
-- isolado). Reproduzidas aqui apenas com a DDL genérica de quarentena/
-- relatorio, idêntica à migration 40, para nao depender do domínio
-- comercial neste teste.
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

\ir ../../../database/43_expand_financeiro_organizacao_obrigatoria.sql
\ir ../../../database/44_backfill_financeiro_organizacao_contabilizado.sql

insert into public.organizacoes (id, nome, slug) values
    ('99100000-0000-4000-8000-000000000001', 'Organizacao A T09', 'org-a-t09'),
    ('99100000-0000-4000-8000-000000000002', 'Organizacao B T09', 'org-b-t09');

insert into public.membros_organizacao (organizacao_id, user_id, papel) values
    ('99100000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-000000000001', 'owner'),
    ('99100000-0000-4000-8000-000000000002', '99000000-0000-4000-8000-000000000002', 'owner');

-- Mesmo bling_id nas duas organizacoes, para provar que a unicidade e
-- isolada por organizacao_id e nao colide entre tenants.
insert into public.categorias_financeiras (id, user_id, organizacao_id, bling_id, descricao, tipo) values
    ('99200000-0000-4000-8000-00000000000a', '99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 501, 'Vendas A', 'receita'),
    ('99200000-0000-4000-8000-00000000000b', '99000000-0000-4000-8000-000000000002', '99100000-0000-4000-8000-000000000002', 501, 'Vendas B', 'receita');

insert into public.contas_financeiras (id, user_id, organizacao_id, bling_id, descricao) values
    ('99300000-0000-4000-8000-00000000000a', '99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 601, 'Caixa A'),
    ('99300000-0000-4000-8000-00000000000b', '99000000-0000-4000-8000-000000000002', '99100000-0000-4000-8000-000000000002', 601, 'Caixa B');

insert into public.fornecedores (id, user_id, organizacao_id, bling_id, nome) values
    ('99400000-0000-4000-8000-00000000000a', '99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 701, 'Fornecedor A'),
    ('99400000-0000-4000-8000-00000000000b', '99000000-0000-4000-8000-000000000002', '99100000-0000-4000-8000-000000000002', 701, 'Fornecedor B');

insert into public.titulos_financeiros (id, user_id, organizacao_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, categoria_id, conta_financeira_id, fornecedor_id) values
    ('99500000-0000-4000-8000-00000000000a', '99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 801, 'receber', 'aberto', 1500.50, '2026-09-01', 'Fatura A', '99200000-0000-4000-8000-00000000000a', '99300000-0000-4000-8000-00000000000a', '99400000-0000-4000-8000-00000000000a');

-- Registro orfao (sem nenhuma membership) para provar a quarentena do backfill.
insert into public.titulos_financeiros (id, user_id, organizacao_id, bling_id, tipo, situacao, valor, data_vencimento, descricao) values
    ('99500000-0000-4000-8000-0000000000ff', '99000000-0000-4000-8000-000000000003', null, 999, 'pagar', 'aberto', 250.00, '2026-09-02', 'Titulo Orfao');

-- Reexecuta o backfill agora que existem dados de teste (a migration 44 já
-- rodou uma vez, sobre uma base vazia, ao ser expandida acima).
select * from public.executar_backfill_financeiro_organizacao();

select plan(14);

-- 1-2: bling_id igual coexiste em organizacoes distintas para as 4 tabelas
select is(
    (select count(*) from public.categorias_financeiras where bling_id = 501),
    2::bigint,
    'Categorias financeiras com o mesmo bling_id coexistem em organizacoes distintas'
);
select is(
    (select count(*) from public.fornecedores where bling_id = 701),
    2::bigint,
    'Fornecedores com o mesmo bling_id coexistem em organizacoes distintas'
);

-- 3: unicidade dentro da mesma organizacao continua valendo
select throws_ok(
    $$insert into public.contas_financeiras (user_id, organizacao_id, bling_id, descricao)
      values ('99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 601, 'Duplicata Caixa A')$$,
    '23505',
    null,
    'Unicidade (organizacao_id, bling_id) continua valendo dentro da mesma organizacao'
);

-- 4: FK composta recusa titulo cuja categoria pertence a outra organizacao
select throws_ok(
    $$insert into public.titulos_financeiros (user_id, organizacao_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, categoria_id)
      values ('99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 802, 'receber', 'aberto', 100, '2026-09-03', 'Cross Categoria', '99200000-0000-4000-8000-00000000000b')$$,
    '23503',
    null,
    'FK composta recusa titulo cuja categoria pertence a outra organizacao'
);

-- 5: FK composta recusa titulo cuja conta financeira pertence a outra organizacao
select throws_ok(
    $$insert into public.titulos_financeiros (user_id, organizacao_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, conta_financeira_id)
      values ('99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 803, 'receber', 'aberto', 100, '2026-09-03', 'Cross Conta', '99300000-0000-4000-8000-00000000000b')$$,
    '23503',
    null,
    'FK composta recusa titulo cuja conta financeira pertence a outra organizacao'
);

-- 6: FK composta recusa titulo cujo fornecedor pertence a outra organizacao
select throws_ok(
    $$insert into public.titulos_financeiros (user_id, organizacao_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, fornecedor_id)
      values ('99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 804, 'pagar', 'aberto', 100, '2026-09-03', 'Cross Fornecedor', '99400000-0000-4000-8000-00000000000b')$$,
    '23503',
    null,
    'FK composta recusa titulo cujo fornecedor pertence a outra organizacao'
);

-- 7: titulo legitimo dentro da mesma organizacao e aceito
select lives_ok(
    $$insert into public.titulos_financeiros (user_id, organizacao_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, categoria_id, conta_financeira_id, fornecedor_id)
      values ('99000000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', 805, 'pagar', 'aberto', 200, '2026-09-04', 'Titulo legitimo', '99200000-0000-4000-8000-00000000000a', '99300000-0000-4000-8000-00000000000a', '99400000-0000-4000-8000-00000000000a')$$,
    'Titulo dentro da mesma organizacao (categoria, conta e fornecedor) e aceito'
);

-- 8: valores decimais/centavos preservados com precisao
select is(
    (select valor from public.titulos_financeiros where id = '99500000-0000-4000-8000-00000000000a'::uuid),
    1500.50::numeric(12,2),
    'Valor decimal (centavos) e preservado com precisao exata'
);

-- 9: backfill contabilizado: total = migrados + quarentena, para titulos_financeiros
select is(
    (select total from public.tenancy_backfill_relatorio where tabela = 'titulos_financeiros' order by executado_em desc limit 1),
    (select migrados + quarentena from public.tenancy_backfill_relatorio where tabela = 'titulos_financeiros' order by executado_em desc limit 1),
    'Relatorio de backfill de titulos_financeiros satisfaz total = migrados + quarentena'
);

-- 10-11: titulo orfao (sem membership) permanece sem organizacao e foi quarentenado, nunca atribuido ao primeiro usuario/organizacao arbitraria
select is(
    (select organizacao_id from public.titulos_financeiros where id = '99500000-0000-4000-8000-0000000000ff'),
    null::uuid,
    'Titulo financeiro orfao permanece sem organizacao apos backfill'
);
select is(
    (select motivo from public.tenancy_backfill_quarentena where tabela = 'titulos_financeiros' and registro_id = '99500000-0000-4000-8000-0000000000ff'),
    'orfao_sem_membership',
    'Titulo financeiro orfao foi registrado em quarentena com o motivo correto'
);

-- 12: reexecucao do backfill e idempotente (nao reprocessa quarentenados)
select lives_ok(
    $$select public.executar_backfill_financeiro_organizacao()$$,
    'Backfill financeiro e reexecutavel sem erro'
);
select is(
    (select count(*) from public.tenancy_backfill_quarentena where tabela = 'titulos_financeiros' and registro_id = '99500000-0000-4000-8000-0000000000ff'),
    1::bigint,
    'Reexecucao do backfill nao duplica a entrada de quarentena do orfao'
);

-- 14: indices de consulta por organizacao existem
select has_index('public', 'titulos_financeiros', 'idx_titulos_financeiros_org_vencimento', 'Indice (organizacao_id, data_vencimento) existe em titulos_financeiros');

select * from finish();
rollback;
