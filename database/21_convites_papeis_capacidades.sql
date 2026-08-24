-- ============================================================================
-- 21_convites_papeis_capacidades.sql
-- Ticket 25: Convites, papéis e capacidades organizacionais
-- Modelagem de convites seguros com expiração, uso único e revogação imediata
-- ============================================================================

-- 1. Tabela de Convites para Organização
create table if not exists public.convites_organizacao (
    id             uuid primary key default gen_random_uuid(),
    organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
    email          text not null check (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    papel          text not null default 'member' check (papel in ('admin', 'member')),
    token          text not null,
    status         text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
    expires_at     timestamptz not null default (now() + interval '7 days'),
    created_by     uuid not null references auth.users(id) on delete cascade,
    accepted_at    timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    constraint uq_convites_token unique (token)
);

-- 2. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
revoke all on public.convites_organizacao from public, anon;
grant select on public.convites_organizacao to authenticated;
grant all on public.convites_organizacao to service_role;

-- 3. Índices de busca e foreign keys
create index if not exists idx_convites_org on public.convites_organizacao(organizacao_id);
create index if not exists idx_convites_email on public.convites_organizacao(email);
create index if not exists idx_convites_token on public.convites_organizacao(token);
create index if not exists idx_convites_status on public.convites_organizacao(status, expires_at);

-- 4. Trigger de updated_at
drop trigger if exists tg_convites_organizacao_updated_at on public.convites_organizacao;
create trigger tg_convites_organizacao_updated_at
    before update on public.convites_organizacao
    for each row execute function public.fn_set_updated_at();

-- 5. Row Level Security (RLS) para Convites
alter table public.convites_organizacao enable row level security;

drop policy if exists "Admins da organizacao podem visualizar convites" on public.convites_organizacao;
create policy "Admins da organizacao podem visualizar convites"
    on public.convites_organizacao
    for select
    using (
        exists (
            select 1 from public.membros_organizacao
            where organizacao_id = convites_organizacao.organizacao_id
              and user_id = auth.uid()
              and papel in ('owner', 'admin')
        )
    );

-- 6. Procedimento Atômico: Criar Convite
create or replace function public.criar_convite_organizacao(
    p_org_id uuid,
    p_email text,
    p_papel text,
    p_token text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller_id uuid;
    v_convite_id uuid;
    v_clean_email text;
begin
    v_caller_id := auth.uid();
    if v_caller_id is null then
        raise exception 'Usuario nao autenticado para criar convite' using errcode = '42501';
    end if;

    -- Verificar se o caller é owner ou admin da organização
    if not exists (
        select 1 from public.membros_organizacao
        where organizacao_id = p_org_id
          and user_id = v_caller_id
          and papel in ('owner', 'admin')
    ) then
        raise exception 'Permissao negada: apenas owner ou admin podem criar convites' using errcode = '42501';
    end if;

    v_clean_email := lower(trim(p_email));
    if v_clean_email is null or char_length(v_clean_email) < 5 then
        raise exception 'Email invalido para convite' using errcode = '22000';
    end if;

    if p_papel not in ('admin', 'member') then
        raise exception 'Papel invalido para convite' using errcode = '22000';
    end if;

    -- Inserir convite
    insert into public.convites_organizacao (
        organizacao_id,
        email,
        papel,
        token,
        created_by
    ) values (
        p_org_id,
        v_clean_email,
        p_papel,
        p_token,
        v_caller_id
    )
    returning id into v_convite_id;

    return v_convite_id;
end;
$$;

revoke all on function public.criar_convite_organizacao(uuid, text, text, text) from public, anon;
grant execute on function public.criar_convite_organizacao(uuid, text, text, text) to authenticated, service_role;

-- 7. Procedimento Atômico: Aceitar Convite (Uso Único e Não Confiando em Papel do Cliente)
create or replace function public.aceitar_convite_organizacao(
    p_token text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid;
    v_convite record;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Usuario nao autenticado para aceitar convite' using errcode = '42501';
    end if;

    -- Buscar e travar o registro do convite para garantir uso estritamente único
    select * into v_convite
    from public.convites_organizacao
    where token = p_token
    for update;

    if not found then
        raise exception 'Convite nao encontrado' using errcode = 'P0002';
    end if;

    if v_convite.status <> 'pending' then
        raise exception 'Convite ja utilizado ou revogado' using errcode = '22000';
    end if;

    if v_convite.expires_at < now() then
        update public.convites_organizacao
        set status = 'expired'
        where id = v_convite.id;

        raise exception 'Convite expirado' using errcode = '22000';
    end if;

    -- Inserir ou atualizar membership com o papel pré-determinado pelo convite
    insert into public.membros_organizacao (
        organizacao_id,
        user_id,
        papel
    ) values (
        v_convite.organizacao_id,
        v_user_id,
        v_convite.papel
    )
    on conflict (organizacao_id, user_id)
    do update set papel = v_convite.papel;

    -- Marcar convite como aceito
    update public.convites_organizacao
    set status = 'accepted',
        accepted_at = now()
    where id = v_convite.id;

    return v_convite.organizacao_id;
end;
$$;

revoke all on function public.aceitar_convite_organizacao(text) from public, anon;
grant execute on function public.aceitar_convite_organizacao(text) to authenticated, service_role;

-- 8. Procedimento Atômico: Revogar Membro com Efeito Imediato
create or replace function public.revogar_membro_organizacao(
    p_org_id uuid,
    p_target_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller_id uuid;
    v_target_papel text;
begin
    v_caller_id := auth.uid();
    if v_caller_id is null then
        raise exception 'Usuario nao autenticado' using errcode = '42501';
    end if;

    -- Verificar se o caller é owner ou admin
    if not exists (
        select 1 from public.membros_organizacao
        where organizacao_id = p_org_id
          and user_id = v_caller_id
          and papel in ('owner', 'admin')
    ) then
        raise exception 'Permissao negada para revogar membros' using errcode = '42501';
    end if;

    -- Obter papel do alvo
    select papel into v_target_papel
    from public.membros_organizacao
    where organizacao_id = p_org_id
      and user_id = p_target_user_id;

    if not found then
        raise exception 'Membro nao encontrado na organizacao' using errcode = 'P0002';
    end if;

    -- Não é permitido revogar o owner diretamente
    if v_target_papel = 'owner' then
        raise exception 'Nao e permitido revogar o proprietario da organizacao' using errcode = '22000';
    end if;

    delete from public.membros_organizacao
    where organizacao_id = p_org_id
      and user_id = p_target_user_id;

    return true;
end;
$$;

revoke all on function public.revogar_membro_organizacao(uuid, uuid) from public, anon;
grant execute on function public.revogar_membro_organizacao(uuid, uuid) to authenticated, service_role;
