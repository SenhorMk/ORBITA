-- financeiro_organizacao.test.sql
-- Ticket 28: Migrar financeiro para a organização
-- Multi-tenancy, RLS e validações anti cross-tenant para o domínio financeiro

begin;

create table public.contas_financeiras (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete cascade,
    bling_id    bigint,
    descricao   text not null,
    tipo        text not null default 'corrente',
    saldo       numeric(12,2) not null default 0.00,
    ativo       boolean not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table public.categorias_financeiras (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete cascade,
    bling_id    bigint,
    descricao   text not null,
    tipo        text not null check (tipo in ('receita', 'despesa')),
    cor         text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table public.fornecedores (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete cascade,
    bling_id    bigint,
    nome        text not null,
    cpf_cnpj    text,
    email       text,
    telefone    text,
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
values ('99000000-0000-4000-8000-000000000001', 'owner-financeiro@orbita.test'),
       ('99000000-0000-4000-8000-000000000002', 'collab-financeiro@orbita.test'),
       ('99000000-0000-4000-8000-000000000003', 'stranger-financeiro@orbita.test');

\ir .generated/20_organizacao_membership_ativa.inc
\ir .generated/21_convites_papeis_capacidades.inc
\ir .generated/24_migrar_financeiro_organizacao.inc

select plan(10);

-- 1. Setup: Criar Org A
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000001';

create temp table temp_org_a as
select public.criar_organizacao_atomica('Financeiro Org A', 'financeiro-org-a') as org_id;

-- Associar Colaborador na Org A
set local role postgres;
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select org_id from temp_org_a), '99000000-0000-4000-8000-000000000002'::uuid, 'member');

-- Criar Org B para o usuário Stranger
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000003';

create temp table temp_org_b as
select public.criar_organizacao_atomica('Financeiro Org B', 'financeiro-org-b') as org_id;

-- 2. Owner da Org A insere registros financeiros
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000001';

insert into public.contas_financeiras (id, user_id, bling_id, descricao, saldo)
values ('99100000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-000000000001', 101, 'Conta Corrente Banco A', 5000.00);

insert into public.categorias_financeiras (id, user_id, bling_id, descricao, tipo)
values ('99200000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-000000000001', 201, 'Vendas de Mercadorias', 'receita');

insert into public.fornecedores (id, user_id, bling_id, nome)
values ('99300000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-000000000001', 301, 'Fornecedor Alpha LTDA');

insert into public.titulos_financeiros (id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, categoria_id, conta_financeira_id, fornecedor_id)
values ('99400000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-000000000001', 401, 'receber', 'aberto', 1500.00, '2026-09-01', 'Fatura 1001', '99200000-0000-4000-8000-000000000001', '99100000-0000-4000-8000-000000000001', '99300000-0000-4000-8000-000000000001');

-- Asserção 1: Conta Financeira auto-preencheu organizacao_id
select is(
    (select organizacao_id from public.contas_financeiras where id = '99100000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Conta financeira foi automaticamente associada a organizacao A'
);

-- Asserção 2: Categoria Financeira auto-preencheu organizacao_id
select is(
    (select organizacao_id from public.categorias_financeiras where id = '99200000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Categoria financeira foi automaticamente associada a organizacao A'
);

-- Asserção 3: Fornecedor auto-preencheu organizacao_id
select is(
    (select organizacao_id from public.fornecedores where id = '99300000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Fornecedor foi automaticamente associado a organizacao A'
);

-- Asserção 4: Título Financeiro auto-preencheu organizacao_id
select is(
    (select organizacao_id from public.titulos_financeiros where id = '99400000-0000-4000-8000-000000000001'::uuid),
    (select org_id from temp_org_a),
    'Titulo financeiro foi automaticamente associado a organizacao A'
);

-- Asserção 5: Colaborador membro da Org A lê Título Financeiro via RLS
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000002';

select is(
    (select count(*) from public.titulos_financeiros where id = '99400000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Colaborador membro da Org A enxerga o titulo financeiro via RLS'
);

-- Asserção 6: Colaborador membro da Org A lê Conta e Categoria via RLS
select is(
    (select count(*) from public.contas_financeiras where id = '99100000-0000-4000-8000-000000000001'::uuid),
    1::bigint,
    'Colaborador membro da Org A enxerga a conta financeira via RLS'
);

-- Asserção 7: Membro da Org B (Stranger) é bloqueado por RLS de ver títulos da Org A
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-4000-8000-000000000003';

select is(
    (select count(*) from public.titulos_financeiros where id = '99400000-0000-4000-8000-000000000001'::uuid),
    0::bigint,
    'Usuario de outro tenant nao enxerga titulos financeiros da Org A'
);

-- Asserção 8: Anti Cross-Tenant bloqueia título com categoria de outra org
select throws_ok(
    $$insert into public.titulos_financeiros (user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, categoria_id)
      values ('99000000-0000-4000-8000-000000000003', 402, 'receber', 'aberto', 200.00, '2026-09-02', 'Cross Categoria', '99200000-0000-4000-8000-000000000001')$$,
    '23503',
    null,
    'Trigger bloqueia criacao de titulo financeiro com categoria de outra organizacao'
);

-- Asserção 9: Anti Cross-Tenant bloqueia título com fornecedor de outra org
select throws_ok(
    $$insert into public.titulos_financeiros (user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao, fornecedor_id)
      values ('99000000-0000-4000-8000-000000000003', 403, 'pagar', 'aberto', 300.00, '2026-09-03', 'Cross Fornecedor', '99300000-0000-4000-8000-000000000001')$$,
    '23503',
    null,
    'Trigger bloqueia criacao de titulo financeiro com fornecedor de outra organizacao'
);

-- Asserção 10: Backfill financeiro executa com sucesso
set local role postgres;
select lives_ok(
    $$select public.migrar_financeiro_para_organizacoes()$$,
    'Procedimento migrar_financeiro_para_organizacoes executa sem erros'
);

select * from finish();
rollback;
