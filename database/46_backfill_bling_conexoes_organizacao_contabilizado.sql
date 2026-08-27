-- ============================================================================
-- 46_backfill_bling_conexoes_organizacao_contabilizado.sql
-- Ticket 10 (orbita-mvp-producao-v2): fase BACKFILL contabilizada e
-- reexecutavel para o vinculo entre integracoes_bling (legado, por user_id)
-- e conexoes_integracao (por organizacao).
--
-- Contexto: a funcao public.migrar_bling_para_organizacoes(), criada na
-- migration 26, nunca foi chamada por nenhum caller de aplicacao ou de
-- migration (auditado via busca reproduzivel; zero ocorrencias fora da
-- propria definicao). Ela tambem violava a regra "nunca atribuir ao
-- primeiro usuario": quando o usuario legado nao tinha uma membership
-- owner/admin, ela caia para "a primeira membership por created_at",
-- uma atribuicao ambigua silenciosa. Esta migration substitui esse
-- comportamento por um backfill contabilizado que:
--
--  - So preenche organizacao_id de uma nova conexao Bling quando o
--    user_id legado tem EXATAMENTE UMA membership em membros_organizacao
--    (relacao inequivoca).
--  - Registra em tenancy_backfill_quarentena (motivo + hash) qualquer
--    user_id legado orfao (0 memberships) ou ambiguo (>1 memberships),
--    sem jamais escolher a "primeira organizacao".
--  - E reexecutavel: linhas ja vinculadas (existe conexoes_integracao com
--    metadata->>'migrado_de_user_id' = user_id) ou ja quarentenadas nao
--    sao reprocessadas.
--  - Contabiliza cada execucao em tenancy_backfill_relatorio com
--    total = migrados + quarentena.
--
-- Escopo deliberado: esta migration migra apenas o VINCULO organizacional
-- da conexao (conexoes_integracao.organizacao_id + metadata de
-- rastreabilidade). Ela NAO tenta recifrar as credenciais legadas
-- (integracoes_bling.client_secret/access_token/refresh_token) para o
-- formato de envelope JSON usado por credenciais_integracao, porque essa
-- recifragem exige a chave de aplicacao (ENCRYPTION_KEY, Node crypto) que
-- nao esta disponivel dentro do Postgres. A migracao de credenciais para
-- conexoes ja vinculadas por esta migration é uma tarefa de aplicacao
-- registrada como needs-owner em
-- .scratch/orbita-mvp-producao-v2/evidence/10-final-evidence.md.
-- ============================================================================

create or replace function public.migrar_bling_conexoes_organizacao_contabilizado()
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
    if not exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'integracoes_bling'
    ) then
        tabela := 'integracoes_bling_conexao'; total := 0; migrados := 0; quarentena := 0;
        return next;
        return;
    end if;

    with alvo as (
        select i.id, i.user_id, i.client_id, i.access_token
        from public.integracoes_bling i
        where not exists (
            select 1 from public.conexoes_integracao c
            where c.provedor = 'bling'
              and c.metadata ->> 'migrado_de_user_id' = i.user_id::text
        )
        and not exists (
            select 1 from public.tenancy_backfill_quarentena q
            where q.tabela = 'integracoes_bling_conexao' and q.registro_id = i.id
        )
    ),
    membership_counts as (
        select a.id, a.user_id, a.client_id, a.access_token,
               count(distinct m.organizacao_id) as n_orgs,
               (array_agg(distinct m.organizacao_id))[1] as unico_org_id
        from alvo a
        left join public.membros_organizacao m on m.user_id = a.user_id
        group by a.id, a.user_id, a.client_id, a.access_token
    ),
    conexao_criada as (
        insert into public.conexoes_integracao (organizacao_id, provedor, nome, status, metadata)
        select
            mc.unico_org_id,
            'bling',
            'Principal',
            case when mc.access_token is not null then 'conectado' else 'pendente' end,
            jsonb_build_object('migrado_de_user_id', mc.user_id, 'migrado_client_id', mc.client_id)
        from membership_counts mc
        where mc.n_orgs = 1
        on conflict (organizacao_id, provedor, nome) do nothing
        returning organizacao_id
    ),
    migrados as (
        select mc.id from membership_counts mc where mc.n_orgs = 1
    ),
    quarentenados as (
        insert into public.tenancy_backfill_quarentena (tabela, registro_id, user_id, motivo, referencia_hash)
        select 'integracoes_bling_conexao', mc.id, mc.user_id,
               case when mc.n_orgs = 0 then 'orfao_sem_membership' else 'ambiguo_multiplas_organizacoes' end,
               md5('integracoes_bling_conexao:' || mc.id::text || ':' || coalesce(mc.user_id::text, 'null'))
        from membership_counts mc
        where mc.n_orgs <> 1
        on conflict (tabela, registro_id) do nothing
        returning registro_id
    )
    select (select count(*) from alvo), (select count(*) from migrados), (select count(*) from quarentenados)
    into v_total, v_migrados, v_quarentena;

    insert into public.tenancy_backfill_relatorio (tabela, total, migrados, quarentena)
    values ('integracoes_bling_conexao', v_total, v_migrados, v_total - v_migrados);

    tabela := 'integracoes_bling_conexao'; total := v_total; migrados := v_migrados; quarentena := v_total - v_migrados;
    return next;
    return;
end;
$$;

revoke all on function public.migrar_bling_conexoes_organizacao_contabilizado() from public, anon, authenticated;
grant execute on function public.migrar_bling_conexoes_organizacao_contabilizado() to service_role;

-- Execucao imediata na propria migration (idempotente / reexecutavel), para
-- que o ambiente resultante ja fique com o backfill aplicado e relatado.
select * from public.migrar_bling_conexoes_organizacao_contabilizado();
