-- produto_excluido_no_bling.test.sql
-- PRE-004, migration 76: `product.deleted` do Bling vira tombstone; o produto
-- local é arquivado sem perder cadastro, itens nem movimentação; um update
-- atrasado não o recria; a reentrega não duplica nada.
--
-- REINTRODUZIR O DEFEITO: tire o gatilho `tg_produto_excluido_no_bling_nao_volta`:
-- 7-10 falham (o update atrasado recria ou regrava o produto excluído). Tire o
-- `if found` da tombstone existente na função: a reentrega tenta reescrever e o
-- teste aborta em 23505. Tire a trava de tombstone imutável: 13-14 falham.

begin;

create table public.organizacoes (id uuid primary key);

create table public.produtos (
    id                uuid primary key default gen_random_uuid(),
    organizacao_id    uuid not null references public.organizacoes(id) on delete cascade,
    bling_id          text not null,
    nome              text not null,
    codigo            text,
    preco             numeric(12,2) not null default 0,
    estoque           integer not null default 0,
    estoque_reservado integer not null default 0,
    imagem_storage_path text,
    constraint uq_produtos_org_bling unique (organizacao_id, bling_id)
);

create table public.pedidos (id uuid primary key default gen_random_uuid());
create table public.itens_pedido (
    id         uuid primary key default gen_random_uuid(),
    pedido_id  uuid not null references public.pedidos(id) on delete cascade,
    produto_id uuid not null references public.produtos(id) on delete restrict,
    quantidade int not null default 1,
    valor_unitario numeric(12,2) not null default 0
);
create table public.movimentacao_estoque (
    id         uuid primary key default gen_random_uuid(),
    produto_id uuid not null references public.produtos(id) on delete cascade,
    quantidade integer not null
);

\ir ../../../database/75_arquivamento_de_produto.sql
\ir ../../../database/76_produto_excluido_no_bling.sql

insert into public.organizacoes values ('76000000-0000-4000-8000-0000000000a1'), ('76000000-0000-4000-8000-0000000000b1');
insert into public.produtos (id, organizacao_id, bling_id, nome, codigo, preco, estoque, estoque_reservado, imagem_storage_path) values
    ('76000000-0000-4000-8000-000000000001', '76000000-0000-4000-8000-0000000000a1', '16714230397', 'Kuripe Cobra', 'KC-01', 80, 5, 2,
     '76000000-0000-4000-8000-0000000000a1/76000000-0000-4000-8000-000000000001/foto.png'),
    ('76000000-0000-4000-8000-000000000002', '76000000-0000-4000-8000-0000000000b1', '16714230397', 'Produto de B', 'B-01', 10, 3, 0, null);
insert into public.pedidos (id) values ('76000000-0000-4000-8000-0000000000d1');
insert into public.itens_pedido (pedido_id, produto_id, quantidade, valor_unitario)
values ('76000000-0000-4000-8000-0000000000d1', '76000000-0000-4000-8000-000000000001', 2, 79.90);
insert into public.movimentacao_estoque (produto_id, quantidade) values ('76000000-0000-4000-8000-000000000001', 5);

select plan(18);

-- ----------------------------------------------------------------------------
-- 1-5. A exclusão no Bling arquiva e preserva; a reentrega não muda nada.
-- ----------------------------------------------------------------------------
create temp table r1 as select * from public.registrar_exclusao_de_produto_no_bling(
    '76000000-0000-4000-8000-0000000000a1', '16714230397', '2026-10-12 10:00:00+00');
select is((select desfecho || '/' || produto_id from r1), 'registrado/76000000-0000-4000-8000-000000000001',
          '1. product.deleted registra a tombstone do produto conhecido');
select is((select situacao || '/' || nome || '/' || preco || '/' || estoque || '/' || estoque_reservado || '/' || (imagem_storage_path is not null)
             from public.produtos where id = '76000000-0000-4000-8000-000000000001'),
          'arquivado/Kuripe Cobra/80.00/5/2/true', '2. o produto é arquivado com cadastro, estoque, reserva e foto intactos');
select is((select count(*)::int from public.itens_pedido where produto_id = '76000000-0000-4000-8000-000000000001')
          || '/' || (select produto_nome from public.itens_pedido where produto_id = '76000000-0000-4000-8000-000000000001')
          || '/' || (select count(*)::int from public.movimentacao_estoque where produto_id = '76000000-0000-4000-8000-000000000001'),
          '1/Kuripe Cobra/1', '3. item do pedido, retrato e movimentação continuam');

create temp table antes as select arquivado_em from public.produtos where id = '76000000-0000-4000-8000-000000000001';
create temp table r2 as select * from public.registrar_exclusao_de_produto_no_bling(
    '76000000-0000-4000-8000-0000000000a1', '16714230397', '2026-10-12 11:00:00+00');
select is((select desfecho from r2)
          || '/' || (select count(*)::int from public.produtos_excluidos_no_bling where bling_id = '16714230397' and organizacao_id = '76000000-0000-4000-8000-0000000000a1')
          || '/' || (select (p.arquivado_em = a.arquivado_em) from public.produtos p, antes a where p.id = '76000000-0000-4000-8000-000000000001')
          || '/' || (select excluido_no_bling_em::text from public.produtos_excluidos_no_bling where bling_id = '16714230397' and organizacao_id = '76000000-0000-4000-8000-0000000000a1'),
          'ja_registrado/1/true/2026-10-12 10:00:00+00', '4. a reentrega responde ja_registrado e não reescreve nada');

create temp table r3 as select * from public.registrar_exclusao_de_produto_no_bling(
    '76000000-0000-4000-8000-0000000000a1', '99999999901', null);
select is((select desfecho from r3) || '/' || (select count(*)::int from public.produtos where bling_id = '99999999901'),
          'registrado_sem_produto/0', '5. id que o ORBITA nunca teve: tombstone, e nenhum produto é criado');

-- ----------------------------------------------------------------------------
-- 6-10. Update atrasado não ressuscita.
-- ----------------------------------------------------------------------------
update public.produtos set preco = 99, nome = 'Nome novo' where id = '76000000-0000-4000-8000-000000000001';
select is((select situacao || '/' || preco from public.produtos where id = '76000000-0000-4000-8000-000000000001'),
          'arquivado/99.00', '6. gravar dados do produto excluído não o desarquiva');
select throws_ok(
    $$insert into public.produtos (organizacao_id, bling_id, nome) values ('76000000-0000-4000-8000-0000000000a1', '99999999901', 'Atrasado')$$,
    '23514', null, '7. update atrasado não cria o produto que o ORBITA nunca teve');
select throws_ok(
    $$insert into public.produtos (organizacao_id, bling_id, nome) values ('76000000-0000-4000-8000-0000000000a1', '16714230397', 'Atrasado')
      on conflict (organizacao_id, bling_id) do update set nome = excluded.nome$$,
    '23514', null, '8. nem o upsert do espelho regrava o produto excluído');
insert into public.produtos (id, organizacao_id, bling_id, nome) values
    ('76000000-0000-4000-8000-000000000003', '76000000-0000-4000-8000-0000000000a1', '55555', 'Outro');
select throws_ok(
    $$update public.produtos set bling_id = '99999999901' where id = '76000000-0000-4000-8000-000000000003'$$,
    '23514', null, '9. nem outro produto passa a apontar para o id excluído');
select is((select nome from public.produtos where id = '76000000-0000-4000-8000-000000000001'), 'Nome novo',
          '10. o upsert recusado não mudou a linha');

-- ----------------------------------------------------------------------------
-- 11-12. Isolamento A/B.
-- ----------------------------------------------------------------------------
select is((select situacao from public.produtos where id = '76000000-0000-4000-8000-000000000002'), 'ativo',
          '11. o mesmo bling_id em outra organização não é afetado');
select lives_ok(
    $$insert into public.produtos (organizacao_id, bling_id, nome) values ('76000000-0000-4000-8000-0000000000b1', '99999999901', 'Existe em B')$$,
    '12. a tombstone de A não impede B');

-- ----------------------------------------------------------------------------
-- 13-15. Tombstone permanente; falha transacional não deixa resto.
-- ----------------------------------------------------------------------------
select throws_ok($$update public.produtos_excluidos_no_bling set excluido_no_bling_em = now()$$, '23514', null,
                 '13. a tombstone não é reescrita');
select throws_ok($$delete from public.produtos_excluidos_no_bling$$, '23514', null, '14. nem apagada');

insert into public.produtos (id, organizacao_id, bling_id, nome) values
    ('76000000-0000-4000-8000-000000000004', '76000000-0000-4000-8000-0000000000a1', '77777', 'Falha no meio');
do $$
begin
    perform * from public.registrar_exclusao_de_produto_no_bling('76000000-0000-4000-8000-0000000000a1', '77777', null);
    raise exception 'queda simulada depois do registro';
exception when others then
    null;
end $$;
select is((select count(*)::int from public.produtos_excluidos_no_bling where bling_id = '77777')
          || '/' || (select situacao from public.produtos where id = '76000000-0000-4000-8000-000000000004'),
          '0/ativo', '15. a transação que cai não deixa tombstone nem arquivamento; a reentrega refaz do zero');

-- ----------------------------------------------------------------------------
-- 16-18. Entrada inválida, cascata da organização e privilégios.
-- ----------------------------------------------------------------------------
select throws_ok(
    $$select * from public.registrar_exclusao_de_produto_no_bling('76000000-0000-4000-8000-0000000000a1', 'LOCAL-1', null)$$,
    '22023', null, '16. id que não é do Bling é recusado');

select * from public.registrar_exclusao_de_produto_no_bling('76000000-0000-4000-8000-0000000000b1', '123456', null);
delete from public.organizacoes where id = '76000000-0000-4000-8000-0000000000b1';
select ok(not exists (select 1 from public.produtos_excluidos_no_bling where organizacao_id = '76000000-0000-4000-8000-0000000000b1'),
          '17. a exclusão da organização leva as tombstones dela');

select ok(not has_function_privilege('authenticated', 'public.registrar_exclusao_de_produto_no_bling(uuid, text, timestamptz)', 'execute')
          and not has_function_privilege('anon', 'public.registrar_exclusao_de_produto_no_bling(uuid, text, timestamptz)', 'execute')
          and has_function_privilege('service_role', 'public.registrar_exclusao_de_produto_no_bling(uuid, text, timestamptz)', 'execute')
          and not has_table_privilege('authenticated', 'public.produtos_excluidos_no_bling', 'select')
          and not has_table_privilege('service_role', 'public.produtos_excluidos_no_bling', 'delete')
          and (select relrowsecurity from pg_class where oid = 'public.produtos_excluidos_no_bling'::regclass),
          '18. só o servidor registra; o navegador não lê; RLS ligada');

select * from finish();
rollback;
