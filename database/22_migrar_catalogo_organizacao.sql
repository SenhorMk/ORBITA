-- ============================================================================
-- 22_migrar_catalogo_organizacao.sql
-- Ticket 26: Migrar catálogo de produtos e categorias para a organização
-- Multi-Tenancy Organizacional para Produtos e Categorias com RLS e Dual-Write
-- ============================================================================

-- 1. Adicionar coluna organizacao_id nas tabelas de catálogo
alter table public.produtos
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

alter table public.categorias
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

-- 2. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
grant select, insert, update, delete on public.produtos to authenticated;
grant select, insert, update, delete on public.categorias to authenticated;
grant all on public.produtos to service_role;
grant all on public.categorias to service_role;

-- 3. Índices para Foreign Key e Unicidade por Organização
create index if not exists idx_produtos_org on public.produtos(organizacao_id);
create index if not exists idx_categorias_org on public.categorias(organizacao_id);

create unique index if not exists uq_produtos_org_bling
    on public.produtos(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

create unique index if not exists uq_categorias_org_bling
    on public.categorias(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

-- 4. Função de Trigger para Dual-Write e Auto-Preenchimento de Tenancy
create or replace function public.fn_sync_catalogo_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_owner_user_id uuid;
begin
    -- Se organizacao_id estiver nulo, resolver a partir da membership do user_id
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

    -- Se user_id estiver nulo, resolver a partir do owner da organização
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

drop trigger if exists trg_sync_produtos_organizacao on public.produtos;
create trigger trg_sync_produtos_organizacao
    before insert or update on public.produtos
    for each row execute function public.fn_sync_catalogo_organizacao();

drop trigger if exists trg_sync_categorias_organizacao on public.categorias;
create trigger trg_sync_categorias_organizacao
    before insert or update on public.categorias
    for each row execute function public.fn_sync_catalogo_organizacao();

-- 5. Procedimento de Backfill Idempotente para Catálogo Histórico
create or replace function public.migrar_catalogo_para_organizacoes()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    -- 1. Preencher produtos sem organizacao_id associando a primeira organizacao do owner/membro
    update public.produtos p
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where p.user_id = m.user_id and p.organizacao_id is null;

    -- 2. Preencher categorias sem organizacao_id
    update public.categorias c
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where c.user_id = m.user_id and c.organizacao_id is null;
end;
$$;

revoke all on function public.migrar_catalogo_para_organizacoes() from public, anon, authenticated;
grant execute on function public.migrar_catalogo_para_organizacoes() to service_role;

-- 6. Atualização de Políticas de Row Level Security (RLS)
alter table public.produtos enable row level security;
alter table public.categorias enable row level security;

drop policy if exists "Isolamento por tenant" on public.produtos;
drop policy if exists "Enable all access for produtos" on public.produtos;
drop policy if exists "Acesso ao catalogo de produtos por organizacao ou user" on public.produtos;

create policy "Acesso ao catalogo de produtos por organizacao ou user"
    on public.produtos
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );

drop policy if exists "Isolamento por tenant" on public.categorias;
drop policy if exists "Enable all access for categorias" on public.categorias;
drop policy if exists "Acesso ao catalogo de categorias por organizacao ou user" on public.categorias;

create policy "Acesso ao catalogo de categorias por organizacao ou user"
    on public.categorias
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );
