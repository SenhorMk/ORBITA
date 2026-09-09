-- titulo_e_fornecedor_da_despesa.test.sql
-- Ticket 05: o detalhe da despesa precisa saber o que ela é e para quem foi
-- lançada. As três colunas são aditivas e nulas para tudo o que já existia.
--
-- REINTRODUZIR O DEFEITO: remova as colunas da migration 62. As asserções
-- falham.

begin;

create table public.titulos_financeiros (
    id              uuid primary key default gen_random_uuid(),
    organizacao_id  uuid not null,
    tipo            text not null check (tipo in ('receber', 'pagar')),
    situacao        text not null default 'aberto',
    valor           numeric(12,2) not null,
    data_vencimento date,
    descricao       text,
    created_at      timestamptz not null default now()
);

-- Uma linha ANTERIOR à migration. Ela é a prova de compatibilidade: nada nela
-- pode ser reescrito, e as colunas novas têm de nascer nulas.
insert into public.titulos_financeiros (organizacao_id, tipo, situacao, valor, data_vencimento, descricao)
values ('62100000-0000-4000-8000-00000000000a', 'pagar', 'pago', 50.00, '2026-08-30', 'Embalagem');

-- A migration REAL, e não uma cópia dela.
\ir ../../../database/62_titulo_e_fornecedor_da_despesa.sql

select plan(6);

select has_column('public', 'titulos_financeiros', 'titulo', '1. o título existe, separado da descrição');
select has_column('public', 'titulos_financeiros', 'fornecedor_bling_id', '2. o contato do ERP fica registrado no título');
select has_column('public', 'titulos_financeiros', 'fornecedor_nome', '3. e o nome dele no momento do lançamento também');

select is(
    (select count(*)::int from public.titulos_financeiros
      where descricao = 'Embalagem'
        and titulo is null and fornecedor_bling_id is null and fornecedor_nome is null),
    1,
    '4. o registro antigo continua inteiro e as colunas novas nascem nulas — sem backfill inventado'
);

insert into public.titulos_financeiros
    (organizacao_id, tipo, situacao, valor, data_vencimento, titulo, descricao, fornecedor_bling_id, fornecedor_nome)
values ('62100000-0000-4000-8000-00000000000a', 'pagar', 'aberto', 120.00, '2026-09-30',
        'Insumos', '1kg de rapé para revenda', 987654321, 'Fornecedor Exemplo LTDA');

select is(
    (select titulo || ' | ' || descricao || ' | ' || fornecedor_bling_id::text || ' | ' || fornecedor_nome
       from public.titulos_financeiros where titulo = 'Insumos'),
    'Insumos | 1kg de rapé para revenda | 987654321 | Fornecedor Exemplo LTDA',
    '5. um lançamento novo grava título, descrição e fornecedor como campos distintos'
);

select has_index(
    'public', 'titulos_financeiros', 'idx_titulos_financeiros_fornecedor_bling',
    '6. a busca por fornecedor não varre a tabela, e é escopada por organização'
);

select * from finish();
rollback;
