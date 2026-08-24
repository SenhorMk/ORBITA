-- ============================================================================
-- 23_migrar_comercial_estoque_fiscal.sql
-- Ticket 27: Migrar clientes, pedidos, estoque e fiscal para a organização
-- Multi-Tenancy Organizacional com RLS e Validação Anti Cross-Tenant
-- ============================================================================

-- 1. Adicionar coluna organizacao_id nas tabelas do ciclo comercial
alter table public.clientes
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

alter table public.pedidos
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

alter table public.itens_pedido
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

alter table public.movimentacao_estoque
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

alter table public.documentos_fiscais
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade;

-- 2. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
grant select, insert, update, delete on public.clientes to authenticated;
grant select, insert, update, delete on public.pedidos to authenticated;
grant select, insert, update, delete on public.itens_pedido to authenticated;
grant select, insert, update, delete on public.movimentacao_estoque to authenticated;
grant select, insert, update, delete on public.documentos_fiscais to authenticated;

grant all on public.clientes to service_role;
grant all on public.pedidos to service_role;
grant all on public.itens_pedido to service_role;
grant all on public.movimentacao_estoque to service_role;
grant all on public.documentos_fiscais to service_role;

-- 3. Índices de Tenancy e Unicidade por Organização
create index if not exists idx_clientes_org on public.clientes(organizacao_id);
create index if not exists idx_pedidos_org on public.pedidos(organizacao_id);
create index if not exists idx_itens_pedido_org on public.itens_pedido(organizacao_id);
create index if not exists idx_movimentacao_estoque_org on public.movimentacao_estoque(organizacao_id);
create index if not exists idx_documentos_fiscais_org on public.documentos_fiscais(organizacao_id);

create unique index if not exists uq_clientes_org_bling
    on public.clientes(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

create unique index if not exists uq_pedidos_org_bling
    on public.pedidos(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

create unique index if not exists uq_documentos_fiscais_org_bling
    on public.documentos_fiscais(organizacao_id, bling_id)
    where organizacao_id is not null and bling_id is not null;

-- 4. Funções de Trigger para Auto-Preenchimento e Integridade Anti Cross-Tenant

-- 4.1 Clientes Trigger Function
create or replace function public.fn_sync_clientes_organizacao()
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

-- 4.2 Pedidos Trigger Function
create or replace function public.fn_sync_pedidos_organizacao()
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

    -- Validação Anti Cross-Tenant para Pedidos -> Clientes
    if new.cliente_id is not null then
        select organizacao_id into v_rel_org_id
        from public.clientes
        where id = new.cliente_id;

        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Cliente pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    return new;
end;
$$;

-- 4.3 Itens do Pedido Trigger Function
create or replace function public.fn_sync_itens_pedido_organizacao()
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
    if new.organizacao_id is null and new.pedido_id is not null then
        select organizacao_id, user_id into v_org_id, v_owner_user_id
        from public.pedidos
        where id = new.pedido_id;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
        if new.user_id is null and v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

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

    -- Validação Anti Cross-Tenant para Itens -> Pedidos e Produtos
    if new.pedido_id is not null then
        select organizacao_id into v_rel_org_id
        from public.pedidos
        where id = new.pedido_id;

        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Pedido pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    if new.produto_id is not null then
        select organizacao_id into v_rel_org_id
        from public.produtos
        where id = new.produto_id;

        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Produto pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    return new;
end;
$$;

-- 4.4 Movimentação de Estoque Trigger Function
create or replace function public.fn_sync_movimentacao_estoque_organizacao()
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
    if new.organizacao_id is null and new.produto_id is not null then
        select organizacao_id, user_id into v_org_id, v_owner_user_id
        from public.produtos
        where id = new.produto_id;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
        if new.user_id is null and v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

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

    -- Validação Anti Cross-Tenant para Movimentação -> Produtos
    if new.produto_id is not null then
        select organizacao_id into v_rel_org_id
        from public.produtos
        where id = new.produto_id;

        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Produto da movimentacao pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    return new;
end;
$$;

-- 4.5 Documentos Fiscais Trigger Function
create or replace function public.fn_sync_documentos_fiscais_organizacao()
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
    if new.organizacao_id is null and new.pedido_id is not null then
        select organizacao_id, user_id into v_org_id, v_owner_user_id
        from public.pedidos
        where id = new.pedido_id;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
        if new.user_id is null and v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

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

    -- Validação Anti Cross-Tenant para Documentos Fiscais -> Pedidos
    if new.pedido_id is not null then
        select organizacao_id into v_rel_org_id
        from public.pedidos
        where id = new.pedido_id;

        if v_rel_org_id is not null and new.organizacao_id is not null and v_rel_org_id != new.organizacao_id then
            raise exception 'Pedido do documento fiscal pertence a outra organizacao' using errcode = '23503';
        end if;
    end if;

    return new;
end;
$$;

-- Vincular triggers
drop trigger if exists trg_sync_clientes_organizacao on public.clientes;
create trigger trg_sync_clientes_organizacao
    before insert or update on public.clientes
    for each row execute function public.fn_sync_clientes_organizacao();

drop trigger if exists trg_sync_pedidos_organizacao on public.pedidos;
create trigger trg_sync_pedidos_organizacao
    before insert or update on public.pedidos
    for each row execute function public.fn_sync_pedidos_organizacao();

drop trigger if exists trg_sync_itens_pedido_organizacao on public.itens_pedido;
create trigger trg_sync_itens_pedido_organizacao
    before insert or update on public.itens_pedido
    for each row execute function public.fn_sync_itens_pedido_organizacao();

drop trigger if exists trg_sync_movimentacao_estoque_organizacao on public.movimentacao_estoque;
create trigger trg_sync_movimentacao_estoque_organizacao
    before insert or update on public.movimentacao_estoque
    for each row execute function public.fn_sync_movimentacao_estoque_organizacao();

drop trigger if exists trg_sync_documentos_fiscais_organizacao on public.documentos_fiscais;
create trigger trg_sync_documentos_fiscais_organizacao
    before insert or update on public.documentos_fiscais
    for each row execute function public.fn_sync_documentos_fiscais_organizacao();

-- 5. Procedimento de Backfill Idempotente para o Ciclo Comercial Histórico
create or replace function public.migrar_comercial_para_organizacoes()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    -- Clientes
    update public.clientes c
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where c.user_id = m.user_id and c.organizacao_id is null;

    -- Pedidos
    update public.pedidos p
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where p.user_id = m.user_id and p.organizacao_id is null;

    -- Itens do Pedido
    update public.itens_pedido i
    set organizacao_id = p.organizacao_id
    from public.pedidos p
    where i.pedido_id = p.id and i.organizacao_id is null and p.organizacao_id is not null;

    -- Movimentação de Estoque
    update public.movimentacao_estoque me
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where me.user_id = m.user_id and me.organizacao_id is null;

    -- Documentos Fiscais
    update public.documentos_fiscais df
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel = 'owner' then 1 else 2 end), created_at asc
    ) m
    where df.user_id = m.user_id and df.organizacao_id is null;
end;
$$;

revoke all on function public.migrar_comercial_para_organizacoes() from public, anon, authenticated;
grant execute on function public.migrar_comercial_para_organizacoes() to service_role;

-- 6. Atualização de Políticas de Row Level Security (RLS)
alter table public.clientes enable row level security;
alter table public.pedidos enable row level security;
alter table public.itens_pedido enable row level security;
alter table public.movimentacao_estoque enable row level security;
alter table public.documentos_fiscais enable row level security;

-- Clientes RLS
drop policy if exists "Isolamento por tenant" on public.clientes;
drop policy if exists "Enable all access for clientes" on public.clientes;
drop policy if exists "Acesso a clientes por organizacao ou user" on public.clientes;
create policy "Acesso a clientes por organizacao ou user"
    on public.clientes
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );

-- Pedidos RLS
drop policy if exists "Isolamento por tenant" on public.pedidos;
drop policy if exists "Enable all access for pedidos" on public.pedidos;
drop policy if exists "Acesso a pedidos por organizacao ou user" on public.pedidos;
create policy "Acesso a pedidos por organizacao ou user"
    on public.pedidos
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );

-- Itens Pedido RLS
drop policy if exists "Isolamento por tenant" on public.itens_pedido;
drop policy if exists "Enable all access for itens_pedido" on public.itens_pedido;
drop policy if exists "Acesso a itens_pedido por organizacao ou user" on public.itens_pedido;
create policy "Acesso a itens_pedido por organizacao ou user"
    on public.itens_pedido
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );

-- Movimentacao Estoque RLS
drop policy if exists "Isolamento por tenant" on public.movimentacao_estoque;
drop policy if exists "Enable all access for movimentacao_estoque" on public.movimentacao_estoque;
drop policy if exists "Acesso a movimentacao_estoque por organizacao ou user" on public.movimentacao_estoque;
create policy "Acesso a movimentacao_estoque por organizacao ou user"
    on public.movimentacao_estoque
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );

-- Documentos Fiscais RLS
drop policy if exists "Isolamento por tenant" on public.documentos_fiscais;
drop policy if exists "Acesso a documentos_fiscais por organizacao ou user" on public.documentos_fiscais;
create policy "Acesso a documentos_fiscais por organizacao ou user"
    on public.documentos_fiscais
    for all
    using (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    )
    with check (
        (organizacao_id is not null and public.usuario_pertence_a_organizacao(organizacao_id))
        or (user_id is not null and user_id = auth.uid())
    );
