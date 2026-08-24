-- ============================================================================
-- 24_migrar_financeiro_organizacao.sql
-- Ticket 28: Migrar financeiro para a organização
-- Multi-Tenancy Organizacional para Contas, Categorias, Fornecedores e Títulos
-- ============================================================================

-- 1. Adicionar coluna organizacao_id nas tabelas do domínio financeiro
alter table public.contas_financeiras
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

alter table public.categorias_financeiras
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

alter table public.fornecedores
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

alter table public.titulos_financeiros
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

-- 2. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
grant select, insert, update, delete on public.contas_financeiras to authenticated;
grant select, insert, update, delete on public.categorias_financeiras to authenticated;
grant select, insert, update, delete on public.fornecedores to authenticated;
grant select, insert, update, delete on public.titulos_financeiros to authenticated;

grant all on public.contas_financeiras to service_role;
grant all on public.categorias_financeiras to service_role;
grant all on public.fornecedores to service_role;
grant all on public.titulos_financeiros to service_role;

-- 3. Índices de Tenancy e Unicidade por Organização
create index if not exists idx_contas_financeiras_org on public.contas_financeiras(organizacao_id);
create index if not exists idx_categorias_financeiras_org on public.categorias_financeiras(organizacao_id);
create index if not exists idx_fornecedores_org on public.fornecedores(organizacao_id);
create index if not exists idx_titulos_financeiros_org on public.titulos_financeiros(organizacao_id);

create unique index if not exists uq_contas_financeiras_org_bling
    on public.contas_financeiras(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

create unique index if not exists uq_categorias_financeiras_org_bling
    on public.categorias_financeiras(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

create unique index if not exists uq_fornecedores_org_bling
    on public.fornecedores(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

create unique index if not exists uq_titulos_financeiros_org_bling
    on public.titulos_financeiros(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

-- 4. Funções de Trigger para Auto-Preenchimento e Integridade Anti Cross-Tenant

-- 4.1 Contas Financeiras Trigger Function
create or replace function public.fn_sync_contas_financeiras_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_owner_user_id uuid;
begin
    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

-- 4.2 Categorias Financeiras Trigger Function
create or replace function public.fn_sync_categorias_financeiras_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_owner_user_id uuid;
begin
    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

-- 4.3 Fornecedores Trigger Function
create or replace function public.fn_sync_fornecedores_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_owner_user_id uuid;
begin
    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

-- 4.4 Títulos Financeiros Trigger Function
create or replace function public.fn_sync_titulos_financeiros_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_owner_user_id uuid;
    v_rel_org_id uuid;
begin
    -- 1. Resolver organizacao_id a partir do membership do user_id
    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    -- 2. Se ainda for nulo e user_id for nulo, tentar herdar de entidades relacionadas
    if new.organizacao_id is null then
        if new.categoria_id is not null then
            select organizacao_id, user_id into v_org_id, v_owner_user_id
            from public.categorias_financeiras
            where id = new.categoria_id;

            if v_org_id is not null then
                new.organizacao_id := v_org_id;
            end if;
        elsif new.conta_financeira_id is not null then
            select organizacao_id, user_id into v_org_id, v_owner_user_id
            from public.contas_financeiras
            where id = new.conta_financeira_id;

            if v_org_id is not null then
                new.organizacao_id := v_org_id;
            end if;
        elsif new.fornecedor_id is not null then
            select organizacao_id, user_id into v_org_id, v_owner_user_id
            from public.fornecedores
            where id = new.fornecedor_id;

            if v_org_id is not null then
                new.organizacao_id := v_org_id;
            end if;
        end if;
    end if;

    -- 3. Se user_id for nulo, resolver a partir do owner da organização
    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    -- 4. Validação Anti Cross-Tenant para Categoria
    if new.categoria_id is not null then
        select organizacao_id into v_rel_org_id
        from public.categorias_financeiras
        where id = new.categoria_id;

        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Categoria financeira pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    -- 5. Validação Anti Cross-Tenant para Conta Financeira
    if new.conta_financeira_id is not null then
        select organizacao_id into v_rel_org_id
        from public.contas_financeiras
        where id = new.conta_financeira_id;

        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Conta financeira pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    -- 6. Validação Anti Cross-Tenant para Fornecedor
    if new.fornecedor_id is not null then
        select organizacao_id into v_rel_org_id
        from public.fornecedores
        where id = new.fornecedor_id;

        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Fornecedor pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    return new;
end;
$$;

-- Vincular triggers
drop trigger if exists trg_sync_contas_financeiras_organizacao on public.contas_financeiras;
create trigger trg_sync_contas_financeiras_organizacao
    before insert or update on public.contas_financeiras
    for each row execute function public.fn_sync_contas_financeiras_organizacao();

drop trigger if exists trg_sync_categorias_financeiras_organizacao on public.categorias_financeiras;
create trigger trg_sync_categorias_financeiras_organizacao
    before insert or update on public.categorias_financeiras
    for each row execute function public.fn_sync_categorias_financeiras_organizacao();

drop trigger if exists trg_sync_fornecedores_organizacao on public.fornecedores;
create trigger trg_sync_fornecedores_organizacao
    before insert or update on public.fornecedores
    for each row execute function public.fn_sync_fornecedores_organizacao();

-- Substitui a validação anterior de tenant único por uma integrada com organização
drop trigger if exists trg_validar_tenancy_titulos_financeiros on public.titulos_financeiros;
drop trigger if exists trg_sync_titulos_financeiros_organizacao on public.titulos_financeiros;
create trigger trg_sync_titulos_financeiros_organizacao
    before insert or update on public.titulos_financeiros
    for each row execute function public.fn_sync_titulos_financeiros_organizacao();

-- 5. Procedimento de Backfill Idempotente para o Domínio Financeiro Histórico
create or replace function public.migrar_financeiro_para_organizacoes()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    -- Contas Financeiras
    update public.contas_financeiras cf
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where cf.user_id = m.user_id and cf.organizacao_id is null;

    -- Categorias Financeiras
    update public.categorias_financeiras cat
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where cat.user_id = m.user_id and cat.organizacao_id is null;

    -- Fornecedores
    update public.fornecedores f
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where f.user_id = m.user_id and f.organizacao_id is null;

    -- Títulos Financeiros
    update public.titulos_financeiros tf
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where tf.user_id = m.user_id and tf.organizacao_id is null;
end;
$$;

revoke all on function public.migrar_financeiro_para_organizacoes() from public, anon, authenticated;
grant execute on function public.migrar_financeiro_para_organizacoes() to service_role;

-- 6. Atualização de Políticas de Row Level Security (RLS)
alter table public.contas_financeiras enable row level security;
alter table public.categorias_financeiras enable row level security;
alter table public.fornecedores enable row level security;
alter table public.titulos_financeiros enable row level security;

-- Contas Financeiras RLS
drop policy if exists "Isolamento por tenant" on public.contas_financeiras;
drop policy if exists "Enable all access for contas_financeiras" on public.contas_financeiras;
drop policy if exists "Acesso a contas_financeiras por organizacao ou user" on public.contas_financeiras;
create policy "Acesso a contas_financeiras por organizacao ou user"
    on public.contas_financeiras
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );

-- Categorias Financeiras RLS
drop policy if exists "Isolamento por tenant" on public.categorias_financeiras;
drop policy if exists "Enable all access for categorias_financeiras" on public.categorias_financeiras;
drop policy if exists "Acesso a categorias_financeiras por organizacao ou user" on public.categorias_financeiras;
create policy "Acesso a categorias_financeiras por organizacao ou user"
    on public.categorias_financeiras
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );

-- Fornecedores RLS
drop policy if exists "Isolamento por tenant" on public.fornecedores;
drop policy if exists "Enable all access for fornecedores" on public.fornecedores;
drop policy if exists "Acesso a fornecedores por organizacao ou user" on public.fornecedores;
create policy "Acesso a fornecedores por organizacao ou user"
    on public.fornecedores
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );

-- Títulos Financeiros RLS
drop policy if exists "Isolamento por tenant" on public.titulos_financeiros;
drop policy if exists "Enable all access for titulos_financeiros" on public.titulos_financeiros;
drop policy if exists "Acesso a titulos_financeiros por organizacao ou user" on public.titulos_financeiros;
create policy "Acesso a titulos_financeiros por organizacao ou user"
    on public.titulos_financeiros
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );
