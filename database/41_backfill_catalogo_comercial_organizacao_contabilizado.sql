-- ============================================================================
-- 41_backfill_catalogo_comercial_organizacao_contabilizado.sql
-- Ticket 08 (orbita-mvp-producao-v2): fase BACKFILL contabilizada e
-- reexecutavel para produtos, categorias, clientes, pedidos, itens_pedido,
-- movimentacao_estoque e documentos_fiscais.
--
-- Regras:
--  - Somente relacoes inequivocas preenchem organizacao_id (exatamente uma
--    membership do user_id, ou heranca direta de um pai ja resolvido).
--  - Orfaos (sem membership) e ambiguos (mais de uma membership) vao para
--    tenancy_backfill_quarentena com motivo e hash de referencia. Nunca sao
--    atribuidos ao "primeiro usuario" ou primeira organizacao arbitraria.
--  - Reexecutavel: linhas ja migradas (organizacao_id preenchido) ou ja
--    quarentenadas (presentes em tenancy_backfill_quarentena) nao sao
--    reprocessadas; contagens de cada execucao sao sempre gravadas em
--    tenancy_backfill_relatorio com total = migrados + quarentena.
-- ============================================================================

create or replace function public.executar_backfill_catalogo_comercial_organizacao()
returns table (tabela text, total integer, migrados integer, quarentena integer)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_total integer;
    v_migrados integer;
    v_quarentena integer;
begin
    -- ------------------------------------------------------------------
    -- PRODUTOS (raiz: resolve por membership do user_id)
    -- ------------------------------------------------------------------
    with alvo as (
        select p.id, p.user_id
        from public.produtos p
        where p.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'produtos' and q.registro_id = p.id
          )
    ),
    membership_counts as (
        select a.id, a.user_id, count(distinct m.organizacao_id) as n_orgs,
               (array_agg(distinct m.organizacao_id))[1] as unico_org_id
        from alvo a
        left join public.membros_organizacao m on m.user_id = a.user_id
        group by a.id, a.user_id
    ),
    atualizados as (
        update public.produtos p
        set organizacao_id = mc.unico_org_id
        from membership_counts mc
        where p.id = mc.id and mc.n_orgs = 1
        returning p.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'produtos', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('produtos:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('produtos', v_total, v_migrados, v_total - v_migrados);
    tabela := 'produtos'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- CATEGORIAS (raiz: resolve por membership do user_id)
    -- ------------------------------------------------------------------
    with alvo as (
        select c.id, c.user_id
        from public.categorias c
        where c.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'categorias' and q.registro_id = c.id
          )
    ),
    membership_counts as (
        select a.id, a.user_id, count(distinct m.organizacao_id) as n_orgs,
               (array_agg(distinct m.organizacao_id))[1] as unico_org_id
        from alvo a
        left join public.membros_organizacao m on m.user_id = a.user_id
        group by a.id, a.user_id
    ),
    atualizados as (
        update public.categorias c
        set organizacao_id = mc.unico_org_id
        from membership_counts mc
        where c.id = mc.id and mc.n_orgs = 1
        returning c.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'categorias', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('categorias:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('categorias', v_total, v_migrados, v_total - v_migrados);
    tabela := 'categorias'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- CLIENTES (raiz: resolve por membership do user_id)
    -- ------------------------------------------------------------------
    with alvo as (
        select c.id, c.user_id
        from public.clientes c
        where c.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'clientes' and q.registro_id = c.id
          )
    ),
    membership_counts as (
        select a.id, a.user_id, count(distinct m.organizacao_id) as n_orgs,
               (array_agg(distinct m.organizacao_id))[1] as unico_org_id
        from alvo a
        left join public.membros_organizacao m on m.user_id = a.user_id
        group by a.id, a.user_id
    ),
    atualizados as (
        update public.clientes c
        set organizacao_id = mc.unico_org_id
        from membership_counts mc
        where c.id = mc.id and mc.n_orgs = 1
        returning c.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'clientes', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('clientes:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('clientes', v_total, v_migrados, v_total - v_migrados);
    tabela := 'clientes'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- PEDIDOS (raiz: resolve por membership do user_id; nao herda do
    -- cliente pois um cliente quarentenado nao pode "emprestar" org a um
    -- pedido nao verificado)
    -- ------------------------------------------------------------------
    with alvo as (
        select p.id, p.user_id
        from public.pedidos p
        where p.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'pedidos' and q.registro_id = p.id
          )
    ),
    membership_counts as (
        select a.id, a.user_id, count(distinct m.organizacao_id) as n_orgs,
               (array_agg(distinct m.organizacao_id))[1] as unico_org_id
        from alvo a
        left join public.membros_organizacao m on m.user_id = a.user_id
        group by a.id, a.user_id
    ),
    atualizados as (
        update public.pedidos p
        set organizacao_id = mc.unico_org_id
        from membership_counts mc
        where p.id = mc.id and mc.n_orgs = 1
        returning p.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'pedidos', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('pedidos:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('pedidos', v_total, v_migrados, v_total - v_migrados);
    tabela := 'pedidos'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- ITENS_PEDIDO (heranca inequivoca: apenas se o pedido pai ja possui
    -- organizacao_id resolvido)
    -- ------------------------------------------------------------------
    with alvo as (
        select i.id, i.user_id, ped.organizacao_id as org_pai
        from public.itens_pedido i
        join public.pedidos ped on ped.id = i.pedido_id
        where i.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'itens_pedido' and q.registro_id = i.id
          )
    ),
    atualizados as (
        update public.itens_pedido i
        set organizacao_id = a.org_pai
        from alvo a
        where i.id = a.id and a.org_pai is not null
        returning i.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'itens_pedido', a.id, a.user_id, 'orfao_sem_membership',
               md5('itens_pedido:' || a.id::text || ':' || coalesce(a.user_id::text, 'null'))
        from alvo a
        where a.org_pai is null
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('itens_pedido', v_total, v_migrados, v_total - v_migrados);
    tabela := 'itens_pedido'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- MOVIMENTACAO_ESTOQUE (heranca inequivoca do produto)
    -- ------------------------------------------------------------------
    with alvo as (
        select me.id, me.user_id, prod.organizacao_id as org_pai
        from public.movimentacao_estoque me
        join public.produtos prod on prod.id = me.produto_id
        where me.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'movimentacao_estoque' and q.registro_id = me.id
          )
    ),
    atualizados as (
        update public.movimentacao_estoque me
        set organizacao_id = a.org_pai
        from alvo a
        where me.id = a.id and a.org_pai is not null
        returning me.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'movimentacao_estoque', a.id, a.user_id, 'orfao_sem_membership',
               md5('movimentacao_estoque:' || a.id::text || ':' || coalesce(a.user_id::text, 'null'))
        from alvo a
        where a.org_pai is null
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('movimentacao_estoque', v_total, v_migrados, v_total - v_migrados);
    tabela := 'movimentacao_estoque'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- DOCUMENTOS_FISCAIS (heranca inequivoca do pedido; pedido_id pode ser
    -- nulo, o que e tratado como orfao)
    -- ------------------------------------------------------------------
    with alvo as (
        select d.id, d.user_id, ped.organizacao_id as org_pai
        from public.documentos_fiscais d
        left join public.pedidos ped on ped.id = d.pedido_id
        where d.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'documentos_fiscais' and q.registro_id = d.id
          )
    ),
    atualizados as (
        update public.documentos_fiscais d
        set organizacao_id = a.org_pai
        from alvo a
        where d.id = a.id and a.org_pai is not null
        returning d.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'documentos_fiscais', a.id, a.user_id, 'orfao_sem_membership',
               md5('documentos_fiscais:' || a.id::text || ':' || coalesce(a.user_id::text, 'null'))
        from alvo a
        where a.org_pai is null
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('documentos_fiscais', v_total, v_migrados, v_total - v_migrados);
    tabela := 'documentos_fiscais'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    return;
end;
$$;

revoke all on function public.executar_backfill_catalogo_comercial_organizacao() from public, anon, authenticated;
grant execute on function public.executar_backfill_catalogo_comercial_organizacao() to service_role;

-- Execucao imediata na propria migration (idempotente / reexecutavel), para
-- que o ambiente resultante ja fique com o backfill aplicado e relatado.
select * from public.executar_backfill_catalogo_comercial_organizacao();
