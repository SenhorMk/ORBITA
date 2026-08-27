-- ============================================================================
-- 44_backfill_financeiro_organizacao_contabilizado.sql
-- Ticket 09 (orbita-mvp-producao-v2): fase BACKFILL contabilizada e
-- reexecutavel para contas_financeiras, categorias_financeiras, fornecedores
-- e titulos_financeiros.
--
-- Regras:
--  - Somente relacoes inequivocas preenchem organizacao_id (exatamente uma
--    membership do user_id). As 4 tabelas desta fatia sao tratadas como raiz
--    (cada uma resolve pela propria membership do seu user_id), pois todas
--    ja carregam user_id proprio -- nao ha heranca de um pai ainda
--    nao-resolvido a considerar aqui (diferente do catalogo/comercial, onde
--    itens_pedido/movimentacao_estoque/documentos_fiscais herdam do pai).
--  - Ambiguos (mais de uma membership) e orfaos (sem membership, incluindo
--    user_id nulo) vao para tenancy_backfill_quarentena com motivo e hash de
--    referencia. Nunca sao atribuidos ao "primeiro usuario" ou primeira
--    organizacao arbitraria.
--  - Reexecutavel: linhas ja migradas (organizacao_id preenchido) ou ja
--    quarentenadas (presentes em tenancy_backfill_quarentena) nao sao
--    reprocessadas; contagens de cada execucao sao sempre gravadas em
--    tenancy_backfill_relatorio com total = migrados + quarentena.
-- ============================================================================

create or replace function public.executar_backfill_financeiro_organizacao()
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
    -- CONTAS_FINANCEIRAS (raiz: resolve por membership do user_id)
    -- ------------------------------------------------------------------
    with alvo as (
        select c.id, c.user_id
        from public.contas_financeiras c
        where c.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'contas_financeiras' and q.registro_id = c.id
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
        update public.contas_financeiras c
        set organizacao_id = mc.unico_org_id
        from membership_counts mc
        where c.id = mc.id and mc.n_orgs = 1
        returning c.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'contas_financeiras', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('contas_financeiras:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('contas_financeiras', v_total, v_migrados, v_total - v_migrados);
    tabela := 'contas_financeiras'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- CATEGORIAS_FINANCEIRAS (raiz: resolve por membership do user_id)
    -- ------------------------------------------------------------------
    with alvo as (
        select c.id, c.user_id
        from public.categorias_financeiras c
        where c.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'categorias_financeiras' and q.registro_id = c.id
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
        update public.categorias_financeiras c
        set organizacao_id = mc.unico_org_id
        from membership_counts mc
        where c.id = mc.id and mc.n_orgs = 1
        returning c.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'categorias_financeiras', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('categorias_financeiras:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('categorias_financeiras', v_total, v_migrados, v_total - v_migrados);
    tabela := 'categorias_financeiras'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- FORNECEDORES (raiz: resolve por membership do user_id)
    -- ------------------------------------------------------------------
    with alvo as (
        select f.id, f.user_id
        from public.fornecedores f
        where f.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'fornecedores' and q.registro_id = f.id
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
        update public.fornecedores f
        set organizacao_id = mc.unico_org_id
        from membership_counts mc
        where f.id = mc.id and mc.n_orgs = 1
        returning f.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'fornecedores', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('fornecedores:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('fornecedores', v_total, v_migrados, v_total - v_migrados);
    tabela := 'fornecedores'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    -- ------------------------------------------------------------------
    -- TITULOS_FINANCEIROS (raiz: resolve por membership do proprio user_id;
    -- nao herda de categoria/conta/fornecedor porque um pai quarentenado nao
    -- pode "emprestar" organizacao a um titulo nao verificado)
    -- ------------------------------------------------------------------
    with alvo as (
        select t.id, t.user_id
        from public.titulos_financeiros t
        where t.organizacao_id is null
          and not exists (
              select 1 from public.tenancy_backfill_quarentena q
              where q.tabela = 'titulos_financeiros' and q.registro_id = t.id
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
        update public.titulos_financeiros t
        set organizacao_id = mc.unico_org_id
        from membership_counts mc
        where t.id = mc.id and mc.n_orgs = 1
        returning t.id
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'titulos_financeiros', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('titulos_financeiros:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from atualizados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;
    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena) values ('titulos_financeiros', v_total, v_migrados, v_total - v_migrados);
    tabela := 'titulos_financeiros'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados; return next;

    return;
end;
$$;

revoke all on function public.executar_backfill_financeiro_organizacao() from public, anon, authenticated;
grant execute on function public.executar_backfill_financeiro_organizacao() to service_role;

-- Execucao imediata na propria migration (idempotente / reexecutavel), para
-- que o ambiente resultante ja fique com o backfill aplicado e relatado.
select * from public.executar_backfill_financeiro_organizacao();
