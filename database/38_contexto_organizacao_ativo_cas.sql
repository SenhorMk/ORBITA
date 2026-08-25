-- Ticket 06: persisted active organization with atomic compare-and-swap.
-- Forward-only, metadata-only table creation. No existing rows are rewritten.

create table if not exists public.contextos_organizacao_ativos (
    user_id uuid primary key references auth.users(id) on delete cascade,
    organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
    versao bigint not null default 1 check (versao > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint fk_contexto_ativo_membership
        foreign key (organizacao_id, user_id)
        references public.membros_organizacao (organizacao_id, user_id)
        on delete cascade
);

alter table public.contextos_organizacao_ativos enable row level security;
revoke all on public.contextos_organizacao_ativos from public, anon, authenticated;
grant select, insert, update, delete on public.contextos_organizacao_ativos to service_role;

create or replace function public.alternar_organizacao_ativa_cas(
    p_user_id uuid,
    p_organizacao_id uuid,
    p_versao_esperada bigint
)
returns table (aplicado boolean, versao bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_versao bigint;
begin
    if p_versao_esperada < 0 then
        raise exception 'Versao esperada invalida' using errcode = '22023';
    end if;

    if not exists (
        select 1
        from public.membros_organizacao m
        where m.user_id = p_user_id
          and m.organizacao_id = p_organizacao_id
    ) then
        raise exception 'Membership ativa obrigatoria' using errcode = '42501';
    end if;

    if p_versao_esperada = 0 then
        insert into public.contextos_organizacao_ativos (user_id, organizacao_id, versao)
        values (p_user_id, p_organizacao_id, 1)
        on conflict (user_id) do nothing
        returning contextos_organizacao_ativos.versao into v_versao;
    else
        update public.contextos_organizacao_ativos as contexto
        set organizacao_id = p_organizacao_id,
            versao = contexto.versao + 1,
            updated_at = now()
        where contexto.user_id = p_user_id
          and contexto.versao = p_versao_esperada
        returning contexto.versao into v_versao;
    end if;

    return query select v_versao is not null, v_versao;
end;
$$;

revoke all on function public.alternar_organizacao_ativa_cas(uuid, uuid, bigint)
from public, anon, authenticated;
grant execute on function public.alternar_organizacao_ativa_cas(uuid, uuid, bigint)
to service_role;
