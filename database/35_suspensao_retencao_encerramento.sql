-- ============================================================================
-- 35_suspensao_retencao_encerramento.sql
-- Ticket 39: Implementar suspensão, retenção e encerramento
-- Ciclo de vida da organização, suspensão, retenção, anonimização e histórico
-- ============================================================================

-- 1. Adicionar colunas de ciclo de vida na tabela organizacoes
alter table public.organizacoes
    add column if not exists status text not null default 'active' check (status in ('active', 'suspended', 'pending_deletion', 'deleted')),
    add column if not exists suspenso_em timestamptz,
    add column if not exists motivo_suspensao text,
    add column if not exists exclusao_agendada_para timestamptz,
    add column if not exists encerrado_em timestamptz,
    add column if not exists metadata_encerramento jsonb default '{}'::jsonb;

create index if not exists idx_organizacoes_status on public.organizacoes(status);

-- 2. Tabela de Histórico Auditável de Ciclo de Vida
create table if not exists public.historico_ciclo_vida_organizacao (
    id             uuid primary key default gen_random_uuid(),
    organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
    acao           text not null check (acao in ('suspensao', 'reativacao', 'agendamento_encerramento', 'cancelamento_encerramento', 'encerramento_definitivo', 'anonimizacao')),
    motivo         text,
    autor_user_id  uuid,
    metadata       jsonb not null default '{}'::jsonb,
    created_at     timestamptz not null default now()
);

create index if not exists idx_historico_ciclo_vida_org
    on public.historico_ciclo_vida_organizacao(organizacao_id, created_at desc);

-- 3. Função Auxiliar: Verificar Papel na Organização
create or replace function public.usuario_tem_papel_na_organizacao(
    p_org_id uuid,
    p_papel text,
    p_user_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.membros_organizacao m
        where m.organizacao_id = p_org_id
          and m.user_id = coalesce(p_user_id, auth.uid())
          and (
            case
              when p_papel = 'owner' then m.papel = 'owner'
              when p_papel = 'admin' then m.papel in ('owner', 'admin')
              else true
            end
          )
    );
$$;

-- 4. Função RPC: Suspender Organização
create or replace function public.suspender_organizacao(
    p_org_id uuid,
    p_motivo text,
    p_autor_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    -- Verificar permissão (apenas service_role ou postgres)
    if current_user not in ('postgres', 'service_role') then
        raise exception 'Apenas administradores de sistema podem suspender organizacoes' using errcode = '42501';
    end if;

    update public.organizacoes
    set status = 'suspended',
        suspenso_em = now(),
        motivo_suspensao = p_motivo,
        updated_at = now()
    where id = p_org_id;

    insert into public.historico_ciclo_vida_organizacao (
        organizacao_id, acao, motivo, autor_user_id
    ) values (
        p_org_id, 'suspensao', p_motivo, p_autor_id
    );
end;
$$;

-- 4. Função RPC: Reativar Organização
create or replace function public.reativar_organizacao(
    p_org_id uuid,
    p_motivo text,
    p_autor_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if current_user not in ('postgres', 'service_role') then
        raise exception 'Apenas administradores de sistema podem reativar organizacoes' using errcode = '42501';
    end if;

    update public.organizacoes
    set status = 'active',
        suspenso_em = null,
        motivo_suspensao = null,
        exclusao_agendada_para = null,
        updated_at = now()
    where id = p_org_id;

    insert into public.historico_ciclo_vida_organizacao (
        organizacao_id, acao, motivo, autor_user_id
    ) values (
        p_org_id, 'reativacao', p_motivo, p_autor_id
    );
end;
$$;

-- 5. Função RPC: Agendar Encerramento da Organização (Retenção / Grace Period)
create or replace function public.agendar_encerramento_organizacao(
    p_org_id uuid,
    p_motivo text,
    p_dias_retencao int default 30,
    p_autor_id uuid default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
    v_exclusao_em timestamptz;
begin
    -- Pode ser invocado pelo Owner da organização ou por service_role
    if not (
        public.usuario_tem_papel_na_organizacao(p_org_id, 'owner')
        or current_user in ('postgres', 'service_role')
    ) then
        raise exception 'Apenas o Owner pode solicitar o encerramento da organizacao' using errcode = '42501';
    end if;

    v_exclusao_em := now() + (coalesce(p_dias_retencao, 30) || ' days')::interval;

    update public.organizacoes
    set status = 'pending_deletion',
        exclusao_agendada_para = v_exclusao_em,
        updated_at = now()
    where id = p_org_id;

    insert into public.historico_ciclo_vida_organizacao (
        organizacao_id, acao, motivo, autor_user_id, metadata
    ) values (
        p_org_id,
        'agendamento_encerramento',
        p_motivo,
        coalesce(p_autor_id, auth.uid()),
        jsonb_build_object('exclusao_agendada_para', v_exclusao_em, 'dias_retencao', p_dias_retencao)
    );

    return v_exclusao_em;
end;
$$;

-- 6. Função RPC: Cancelar Agendamento de Encerramento
create or replace function public.cancelar_agendamento_encerramento(
    p_org_id uuid,
    p_autor_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not (
        public.usuario_tem_papel_na_organizacao(p_org_id, 'owner')
        or current_user in ('postgres', 'service_role')
    ) then
        raise exception 'Apenas o Owner pode cancelar o encerramento da organizacao' using errcode = '42501';
    end if;

    update public.organizacoes
    set status = 'active',
        exclusao_agendada_para = null,
        updated_at = now()
    where id = p_org_id and status = 'pending_deletion';

    insert into public.historico_ciclo_vida_organizacao (
        organizacao_id, acao, motivo, autor_user_id
    ) values (
        p_org_id, 'cancelamento_encerramento', 'Cancelamento solicitado pelo Owner', coalesce(p_autor_id, auth.uid())
    );
end;
$$;

-- 7. Função RPC: Executar Encerramento Definitivo e Anonimização
create or replace function public.executar_encerramento_definitivo(
    p_org_id uuid,
    p_motivo text default 'Encerramento do período de retenção'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if current_user not in ('postgres', 'service_role') then
        raise exception 'Apenas processos do sistema podem executar o encerramento definitivo' using errcode = '42501';
    end if;

    -- 1. Anonimizar dados pessoais de clientes (LGPD / GDPR)
    update public.clientes
    set nome = 'Cliente Anonimizado',
        cpf_cnpj = null,
        email = null,
        telefone = null,
        telefone_normalizado = null
    where organizacao_id = p_org_id;

    -- 2. Revogar credenciais e conexões ativas
    update public.conexoes_integracao
    set status = 'revogada'
    where organizacao_id = p_org_id;

    -- 3. Cancelar convites pendentes
    update public.convites_organizacao
    set status = 'revoked', updated_at = now()
    where organizacao_id = p_org_id and status = 'pending';

    -- 4. Marcar organização como deletada
    update public.organizacoes
    set status = 'deleted',
        encerrado_em = now(),
        updated_at = now()
    where id = p_org_id;

    -- 5. Registrar histórico auditável
    insert into public.historico_ciclo_vida_organizacao (
        organizacao_id, acao, motivo, metadata
    ) values (
        p_org_id,
        'encerramento_definitivo',
        p_motivo,
        jsonb_build_object('encerrado_em', now(), 'anonimizacao_executada', true)
    );
end;
$$;

-- 8. Privilégios Mínimos e RLS (OWASP ASVS L2)
revoke all on public.historico_ciclo_vida_organizacao from public, anon;
revoke all on function public.usuario_tem_papel_na_organizacao(uuid, text, uuid) from public, anon;
revoke all on function public.suspender_organizacao(uuid, text, uuid) from public, anon;
revoke all on function public.reativar_organizacao(uuid, text, uuid) from public, anon;
revoke all on function public.agendar_encerramento_organizacao(uuid, text, int, uuid) from public, anon;
revoke all on function public.cancelar_agendamento_encerramento(uuid, uuid) from public, anon;
revoke all on function public.executar_encerramento_definitivo(uuid, text) from public, anon;

grant select on public.historico_ciclo_vida_organizacao to authenticated;
grant all on public.historico_ciclo_vida_organizacao to service_role;

grant execute on function public.usuario_tem_papel_na_organizacao(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.suspender_organizacao(uuid, text, uuid) to service_role;
grant execute on function public.reativar_organizacao(uuid, text, uuid) to service_role;
grant execute on function public.agendar_encerramento_organizacao(uuid, text, int, uuid) to authenticated, service_role;
grant execute on function public.cancelar_agendamento_encerramento(uuid, uuid) to authenticated, service_role;
grant execute on function public.executar_encerramento_definitivo(uuid, text) to service_role;

alter table public.historico_ciclo_vida_organizacao enable row level security;

drop policy if exists "Admins podem visualizar historico de ciclo de vida da organizacao" on public.historico_ciclo_vida_organizacao;
create policy "Admins podem visualizar historico de ciclo de vida da organizacao"
    on public.historico_ciclo_vida_organizacao
    for select
    to authenticated
    using (public.usuario_tem_papel_na_organizacao(organizacao_id, 'admin'));
