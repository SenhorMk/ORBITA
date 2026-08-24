-- quarentena_financeiro.test.sql
-- Ticket 16: Classificar e quarentenar registros financeiros sem tenant

begin;

-- Fixtures descartáveis
create table public.titulos_financeiros (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete cascade,
    bling_id        bigint unique,
    tipo            text not null check (tipo in ('receber','pagar')),
    situacao        text not null,
    valor           numeric(10,2) not null,
    data_vencimento date not null,
    descricao       text not null
);

create table public.categorias_financeiras (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid references auth.users(id) on delete cascade,
    bling_id  bigint unique,
    descricao text not null,
    tipo      text
);

create table public.contas_financeiras (
    id        uuid primary key default gen_random_uuid(),
    user_id   uuid references auth.users(id) on delete cascade,
    bling_id  bigint unique,
    descricao text not null,
    tipo      smallint not null default 1
);

insert into auth.users (id, email)
values ('80000000-0000-4000-8000-000000000001', 'tenant-quarentena@orbita.test');

\ir .generated/12_quarentena_financeiro_sem_tenant.inc

select plan(8);

-- 1. Inserir registro com tenant e registro sem tenant (órfão)
insert into public.titulos_financeiros (id, user_id, bling_id, tipo, situacao, valor, data_vencimento, descricao)
values
    ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 999001, 'receber', 'aberto', 100.00, current_date, 'Venda Tenant A'),
    ('81000000-0000-4000-8000-000000000002', null, 999002, 'pagar', 'aberto', 250.00, current_date, 'Despesa Orfa Sem Tenant');

select is(
    (select count(*) from public.titulos_financeiros),
    2::bigint,
    '2 titulos presentes antes da quarentena (1 com tenant, 1 sem tenant)'
);

-- 2. Executar procedimento de quarentena
select public.quarentenar_registros_financeiros_sem_tenant();

-- 3. Verificar que o órfão foi removido da tabela ativa e preservado na quarentena
select is(
    (select count(*) from public.titulos_financeiros),
    1::bigint,
    'Apenas o titulo do tenant legitimo permaneceu na tabela ativa'
);

select is(
    (select id from public.titulos_financeiros limit 1),
    '81000000-0000-4000-8000-000000000001'::uuid,
    'O titulo que permaneceu eh o titulo associado ao Tenant A'
);

select is(
    (select count(*) from public.quarentena_financeira where registro_id = '81000000-0000-4000-8000-000000000002'::uuid and status = 'em_quarentena'),
    1::bigint,
    'Registro orfao foi catalogado com sucesso na quarentena_financeira'
);

-- 4. Idempotência: reexecutar não gera duplicações
select public.quarentenar_registros_financeiros_sem_tenant();

select is(
    (select count(*) from public.quarentena_financeira where registro_id = '81000000-0000-4000-8000-000000000002'::uuid),
    1::bigint,
    'Quarentena eh idempotente: reexecucao nao duplica registros'
);

-- 5. Testar bloqueio de acesso para usuário anônimo
set local role anon;
select throws_ok(
    $$ select * from public.quarentena_financeira $$,
    '42501',
    NULL,
    'Role anon eh impedida de ler registros em quarentena (42501)'
);
reset role;

-- 6. Testar bloqueio de acesso para usuário autenticado comum
set local role authenticated;
set local "request.jwt.claims" to '{"sub": "80000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select throws_ok(
    $$ select * from public.quarentena_financeira $$,
    '42501',
    NULL,
    'Role authenticated eh impedida de ler registros em quarentena (42501)'
);
reset role;

-- 7. Service role tem acesso de leitura para auditoria e triagem
set local role service_role;
select is(
    (select count(*) from public.quarentena_financeira),
    1::bigint,
    'Service role consegue auditar registros na quarentena'
);
reset role;

select * from finish();
rollback;
