-- titulo_terminal_monotonico.test.sql
-- Migration 68: o código bruto do Bling é preservado, e um título terminal não
-- volta a ativo por uma gravação comum de sincronização.
--
-- REINTRODUZIR O DEFEITO: remova o gatilho `tg_titulo_terminal_nao_regride` da
-- migration 68. As asserções 4, 5 e 6 falham — o `cancelado` volta a `aberto`
-- e o `estornado` volta a `pago`.

begin;

create table public.titulos_financeiros (
    id              uuid primary key default gen_random_uuid(),
    organizacao_id  uuid not null,
    bling_id        bigint,
    tipo            text not null check (tipo in ('receber', 'pagar')),
    situacao        text not null check (situacao in ('aberto', 'pago', 'cancelado', 'estornado')),
    valor           numeric(12,2) not null,
    descricao       text not null default 'x',
    constraint uq_titulos_financeiros_org_bling unique (organizacao_id, bling_id)
);

-- A migration REAL, e não uma cópia: copiar o gatilho para dentro do teste
-- faria o teste passar mesmo se a migration o perdesse.
\ir ../../../database/68_situacao_bling_e_titulo_terminal_monotonico.sql

select plan(10);

-- ============================================================================
-- CÓDIGO BRUTO
-- ============================================================================
select throws_ok(
    $q$insert into public.titulos_financeiros (organizacao_id, bling_id, tipo, situacao, valor, situacao_bling)
       values ('68100000-0000-4000-8000-00000000000a', 1, 'pagar', 'aberto', 10, 8)$q$,
    '23514', null,
    '1. situacao_bling fora de 1..7 é recusado'
);

insert into public.titulos_financeiros (organizacao_id, bling_id, tipo, situacao, valor, situacao_bling)
values ('68100000-0000-4000-8000-00000000000a', 3, 'pagar', 'aberto', 10, 3);

select is(
    (select situacao_bling::int from public.titulos_financeiros where bling_id = 3),
    3,
    '2. o código 3 (Parcial) fica preservado ao lado da projeção `aberto`'
);

select lives_ok(
    $q$insert into public.titulos_financeiros (organizacao_id, tipo, situacao, valor)
       values ('68100000-0000-4000-8000-00000000000a', 'pagar', 'pago', 5)$q$,
    '3. título interno segue sem situacao_bling'
);

-- ============================================================================
-- TERMINAL NÃO REGRIDE
-- ============================================================================
insert into public.titulos_financeiros (organizacao_id, bling_id, tipo, situacao, valor)
values ('68100000-0000-4000-8000-00000000000a', 100, 'receber', 'cancelado', 40),
       ('68100000-0000-4000-8000-00000000000a', 101, 'receber', 'estornado', 40);

-- O upsert EXATO que a sincronização emite (`onConflict: organizacao_id, bling_id`).
insert into public.titulos_financeiros (organizacao_id, bling_id, tipo, situacao, valor, situacao_bling)
values ('68100000-0000-4000-8000-00000000000a', 100, 'receber', 'aberto', 45, 1)
on conflict (organizacao_id, bling_id) do update
    set situacao = excluded.situacao, valor = excluded.valor, situacao_bling = excluded.situacao_bling;

select is(
    (select situacao from public.titulos_financeiros where bling_id = 100),
    'cancelado',
    '4. o upsert da sincronização não reabre um título `cancelado`'
);

insert into public.titulos_financeiros (organizacao_id, bling_id, tipo, situacao, valor, situacao_bling)
values ('68100000-0000-4000-8000-00000000000a', 101, 'receber', 'pago', 40, 2)
on conflict (organizacao_id, bling_id) do update
    set situacao = excluded.situacao, situacao_bling = excluded.situacao_bling;

select is(
    (select situacao from public.titulos_financeiros where bling_id = 101),
    'estornado',
    '5. …nem devolve um `estornado` a `pago`'
);

update public.titulos_financeiros set situacao = 'aberto' where bling_id = 100;

select is(
    (select situacao from public.titulos_financeiros where bling_id = 100),
    'cancelado',
    '6. um UPDATE comum também não reabre — a regra está no banco, não na rota'
);

select is(
    (select (valor, situacao_bling::int)::text from public.titulos_financeiros where bling_id = 100),
    '(45.00,1)',
    '7. as demais colunas continuam atualizáveis: o código bruto registra o que o Bling diz'
);

-- ============================================================================
-- ATIVO CONTINUA LIVRE
-- ============================================================================
update public.titulos_financeiros set situacao = 'pago' where bling_id = 3;

select is(
    (select situacao from public.titulos_financeiros where bling_id = 3),
    'pago',
    '8. ativo → ativo segue livre'
);

update public.titulos_financeiros set situacao = 'cancelado', situacao_bling = 5 where bling_id = 3;

select is(
    (select situacao from public.titulos_financeiros where bling_id = 3),
    'cancelado',
    '9. ativo → terminal segue livre (é o caminho do cancelamento)'
);

select ok(
    not has_function_privilege('authenticated', 'public.fn_titulo_terminal_nao_regride()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.fn_titulo_terminal_nao_regride()', 'EXECUTE'),
    '10. a função do gatilho não é executável por navegador'
);

select * from finish();
rollback;
