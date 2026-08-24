-- ============================================================================
-- 20_organizacao_membership_ativa.sql
-- Ticket 24: Criar organização, membership e organização ativa
-- Modelagem de Tenancy Multi-Tenant via Organizações e Memberships com RLS
-- ============================================================================

-- 0. Garantir função canônica de timestamp
create or replace function public.fn_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- 1. Tabela de Organizações
create table if not exists public.organizacoes (
    id         uuid primary key default gen_random_uuid(),
    nome       text not null check (char_length(trim(nome)) >= 2),
    slug       text not null check (char_length(trim(slug)) >= 2),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint uq_organizacoes_slug unique (slug)
);

-- 2. Tabela de Memberships (Membros da Organização)
create table if not exists public.membros_organizacao (
    id             uuid primary key default gen_random_uuid(),
    organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
    user_id        uuid not null references auth.users(id) on delete cascade,
    papel          text not null default 'member' check (papel in ('owner', 'admin', 'member')),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    constraint uq_membros_org_user unique (organizacao_id, user_id)
);

-- 3. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
revoke all on public.organizacoes from public, anon;
revoke all on public.membros_organizacao from public, anon;

grant select, update on public.organizacoes to authenticated;
grant select on public.membros_organizacao to authenticated;
grant all on public.organizacoes to service_role;
grant all on public.membros_organizacao to service_role;

-- 4. Índices para Foreign Keys e consultas de membership
create index if not exists idx_membros_org_user on public.membros_organizacao(user_id);
create index if not exists idx_membros_org_org on public.membros_organizacao(organizacao_id);

-- 5. Triggers de updated_at
drop trigger if exists tg_organizacoes_updated_at on public.organizacoes;
create trigger tg_organizacoes_updated_at
    before update on public.organizacoes
    for each row execute function public.fn_set_updated_at();

drop trigger if exists tg_membros_organizacao_updated_at on public.membros_organizacao;
create trigger tg_membros_organizacao_updated_at
    before update on public.membros_organizacao
    for each row execute function public.fn_set_updated_at();

-- 6. Função helper para verificar membership em RLS
create or replace function public.usuario_pertence_a_organizacao(org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select exists (
        select 1 from public.membros_organizacao
        where organizacao_id = org_id
          and user_id = auth.uid()
    );
$$;

revoke all on function public.usuario_pertence_a_organizacao(uuid) from public, anon;
grant execute on function public.usuario_pertence_a_organizacao(uuid) to authenticated, service_role;

-- 7. Habilitação e Políticas de Row Level Security (RLS)
alter table public.organizacoes enable row level security;
alter table public.membros_organizacao enable row level security;

drop policy if exists "Membros podem visualizar suas organizacoes" on public.organizacoes;
create policy "Membros podem visualizar suas organizacoes"
    on public.organizacoes
    for select
    using (public.usuario_pertence_a_organizacao(id));

drop policy if exists "Admins podem atualizar sua organizacao" on public.organizacoes;
create policy "Admins podem atualizar sua organizacao"
    on public.organizacoes
    for update
    using (
        exists (
            select 1 from public.membros_organizacao
            where organizacao_id = organizacoes.id
              and user_id = auth.uid()
              and papel in ('owner', 'admin')
        )
    );

drop policy if exists "Membros podem visualizar memberships de sua organizacao" on public.membros_organizacao;
create policy "Membros podem visualizar memberships de sua organizacao"
    on public.membros_organizacao
    for select
    using (
        user_id = auth.uid()
        or public.usuario_pertence_a_organizacao(organizacao_id)
    );

-- 8. Função Atômica para Criação de Organização com Owner Membership
create or replace function public.criar_organizacao_atomica(
    p_nome text,
    p_slug text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid;
    v_org_id uuid;
    v_clean_slug text;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Usuario nao autenticado para criar organizacao' using errcode = '42501';
    end if;

    if trim(p_nome) is null or char_length(trim(p_nome)) < 2 then
        raise exception 'Nome da organizacao deve ter no minimo 2 caracteres' using errcode = '22000';
    end if;

    v_clean_slug := lower(regexp_replace(trim(p_slug), '[^a-zA-Z0-9_-]', '-', 'g'));
    if char_length(v_clean_slug) < 2 then
        raise exception 'Slug invalido para a organizacao' using errcode = '22000';
    end if;

    -- Inserir organização
    insert into public.organizacoes (nome, slug)
    values (trim(p_nome), v_clean_slug)
    returning id into v_org_id;

    -- Inserir criador como owner da organização
    insert into public.membros_organizacao (organizacao_id, user_id, papel)
    values (v_org_id, v_user_id, 'owner');

    return v_org_id;
end;
$$;

revoke all on function public.criar_organizacao_atomica(text, text) from public, anon;
grant execute on function public.criar_organizacao_atomica(text, text) to authenticated, service_role;
