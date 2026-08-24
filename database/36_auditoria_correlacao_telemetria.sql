-- ============================================================================
-- 36_auditoria_correlacao_telemetria.sql
-- Ticket 40: Adicionar auditoria, correlação e telemetria
-- Trilha de auditoria imutável, correlação ponta a ponta e telemetria segura
-- ============================================================================

-- 1. Tabela de Trilha de Auditoria Imutável
create table if not exists public.eventos_auditoria_sistema (
    id             uuid primary key default gen_random_uuid(),
    organizacao_id uuid references public.organizacoes(id) on delete set null,
    actor_id       uuid,
    acao           text not null,
    recurso        text not null,
    recurso_id     text,
    correlation_id text,
    ip_address     text,
    user_agent     text,
    metadata       jsonb not null default '{}'::jsonb,
    created_at     timestamptz not null default now()
);

-- Índices otimizados para busca por organização, correlação e ator
create index if not exists idx_auditoria_org_created
    on public.eventos_auditoria_sistema(organizacao_id, created_at desc);

create index if not exists idx_auditoria_correlation
    on public.eventos_auditoria_sistema(correlation_id)
    where correlation_id is not null;

create index if not exists idx_auditoria_actor
    on public.eventos_auditoria_sistema(actor_id, created_at desc)
    where actor_id is not null;

create index if not exists idx_auditoria_acao
    on public.eventos_auditoria_sistema(acao);

-- 2. Função RPC: Registrar Evento de Auditoria
create or replace function public.registrar_evento_auditoria(
    p_org_id uuid,
    p_actor_id uuid,
    p_acao text,
    p_recurso text,
    p_recurso_id text default null,
    p_correlation_id text default null,
    p_ip_address text default null,
    p_user_agent text default null,
    p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_event_id uuid;
    v_effective_actor uuid;
begin
    v_effective_actor := coalesce(p_actor_id, auth.uid());

    insert into public.eventos_auditoria_sistema (
        organizacao_id,
        actor_id,
        acao,
        recurso,
        recurso_id,
        correlation_id,
        ip_address,
        user_agent,
        metadata
    ) values (
        p_org_id,
        v_effective_actor,
        trim(p_acao),
        trim(p_recurso),
        p_recurso_id,
        p_correlation_id,
        p_ip_address,
        p_user_agent,
        coalesce(p_metadata, '{}'::jsonb)
    )
    returning id into v_event_id;

    return v_event_id;
end;
$$;

-- 3. Privilégios Mínimos e RLS (OWASP ASVS L2)
revoke all on public.eventos_auditoria_sistema from public, anon;
revoke all on function public.registrar_evento_auditoria(uuid, uuid, text, text, text, text, text, text, jsonb) from public, anon;

grant select on public.eventos_auditoria_sistema to authenticated;
grant all on public.eventos_auditoria_sistema to service_role;
grant execute on function public.registrar_evento_auditoria(uuid, uuid, text, text, text, text, text, text, jsonb) to authenticated, service_role;

alter table public.eventos_auditoria_sistema enable row level security;

-- Política de RLS: Admins e Owners podem visualizar apenas eventos da sua organização
drop policy if exists "Admins podem visualizar auditoria da sua organizacao" on public.eventos_auditoria_sistema;
create policy "Admins podem visualizar auditoria da sua organizacao"
    on public.eventos_auditoria_sistema
    for select
    to authenticated
    using (
        organizacao_id is not null
        and exists (
            select 1
            from public.membros_organizacao m
            where m.organizacao_id = eventos_auditoria_sistema.organizacao_id
              and m.user_id = auth.uid()
              and m.papel in ('owner', 'admin')
        )
    );
