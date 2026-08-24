-- ============================================================================
-- 30_jobs_sync_duraveis.sql
-- Ticket 34: Executar sincronizações como jobs duráveis
-- Jobs com lease PostgreSQL, checkpoints atômicos e crash recovery
-- ============================================================================

-- 1. Tabela de Jobs de Sincronização
create table if not exists public.sync_jobs (
    id               uuid primary key default gen_random_uuid(),
    organizacao_id   uuid not null references public.organizacoes(id) on delete cascade,
    triggered_by     uuid references auth.users(id) on delete set null,
    status           text not null default 'queued'
                     check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
    progress         jsonb not null default '{}',
    lease_expires_at timestamptz,
    last_error       text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    completed_at     timestamptz
);

-- 2. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
revoke all on public.sync_jobs from public, anon;
grant select on public.sync_jobs to authenticated;
grant all on public.sync_jobs to service_role, postgres;

-- 3. Índices

-- Índice parcial único: impede múltiplos jobs ativos (queued ou running) por organização
-- Uma organização jamais terá dois jobs simultâneos — o RPC é idempotente
create unique index if not exists uq_sync_jobs_org_active
    on public.sync_jobs(organizacao_id)
    where status in ('queued', 'running');

create index if not exists idx_sync_jobs_org_status
    on public.sync_jobs(organizacao_id, status, created_at desc);

create index if not exists idx_sync_jobs_lease
    on public.sync_jobs(lease_expires_at)
    where status = 'running';

-- 4. Trigger de updated_at
drop trigger if exists tg_sync_jobs_updated_at on public.sync_jobs;
create trigger tg_sync_jobs_updated_at
    before update on public.sync_jobs
    for each row execute function public.fn_set_updated_at();

-- 5. Row Level Security — membros da organização podem ler seus jobs
alter table public.sync_jobs enable row level security;

drop policy if exists "Acesso a sync_jobs por organizacao" on public.sync_jobs;
create policy "Acesso a sync_jobs por organizacao"
    on public.sync_jobs
    for select
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

-- 6. RPC: Registrar (ou retornar job ativo existente) — idempotente
-- Se já existe um job queued ou running para a organização, retorna-o sem criar duplicata.
create or replace function public.registrar_job_sync(
    p_organizacao_id uuid,
    p_triggered_by   uuid
)
returns table (
    job_id  uuid,
    status  text,
    is_new  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existente record;
    v_new_id    uuid;
begin
    -- Verifica se já existe um job ativo (queued ou running) para esta organização
    select id, sync_jobs.status into v_existente
    from public.sync_jobs
    where organizacao_id = p_organizacao_id
      and sync_jobs.status in ('queued', 'running')
    limit 1;

    if found then
        return query select v_existente.id, v_existente.status, false;
        return;
    end if;

    -- Cria novo job
    insert into public.sync_jobs (organizacao_id, triggered_by, status)
    values (p_organizacao_id, p_triggered_by, 'queued')
    returning id into v_new_id;

    return query select v_new_id, 'queued'::text, true;
    return;
end;
$$;

-- 7. RPC: Adquirir lease (transição queued → running com TTL)
-- Usa SELECT FOR UPDATE SKIP LOCKED para evitar corridas entre processos concorrentes.
-- Retorna true se o lease foi adquirido, false se outro processo já o possui.
create or replace function public.adquirir_lease_job_sync(
    p_job_id         uuid,
    p_lease_ttl_min  integer default 10
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_job record;
begin
    -- Tenta bloquear a linha exclusivamente; SKIP LOCKED devolve 0 linhas se já bloqueada
    select id, status, lease_expires_at into v_job
    from public.sync_jobs
    where id = p_job_id
      and status in ('queued', 'running')
    for update skip locked;

    if not found then
        -- Job não existe, já foi concluído ou está bloqueado por outro processo
        return false;
    end if;

    -- Se já está running mas o lease não expirou, outro processo é o dono
    if v_job.status = 'running'
       and v_job.lease_expires_at is not null
       and v_job.lease_expires_at > now() then
        return false;
    end if;

    -- Adquire/renova o lease
    update public.sync_jobs
    set status           = 'running',
        lease_expires_at = now() + (p_lease_ttl_min || ' minutes')::interval,
        updated_at       = now()
    where id = p_job_id;

    return true;
end;
$$;

-- 8. RPC: Avançar checkpoint (sem alterar status)
-- Chamado após cada lote bem-sucedido; uma falha posterior não apaga o progresso confirmado.
create or replace function public.avancar_checkpoint_job_sync(
    p_job_id   uuid,
    p_progress jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.sync_jobs
    set progress         = p_progress,
        lease_expires_at = now() + interval '10 minutes', -- renova lease ao avançar
        updated_at       = now()
    where id = p_job_id
      and status = 'running';
end;
$$;

-- 9. RPC: Concluir job (completed | failed | cancelled)
create or replace function public.concluir_job_sync(
    p_job_id uuid,
    p_status text,
    p_error  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.sync_jobs
    set status           = p_status,
        last_error       = p_error,
        lease_expires_at = null,
        completed_at     = case when p_status in ('completed', 'failed', 'cancelled') then now() else completed_at end,
        updated_at       = now()
    where id = p_job_id;
end;
$$;

-- 10. RPC: Recuperação de crash — libera leases expirados
-- Jobs que ficaram em 'running' após o processo morrer voltam para 'queued'.
-- Deve ser chamada periodicamente (ex.: na inicialização do servidor ou em cron).
create or replace function public.liberar_leases_expirados_sync()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_count integer;
begin
    update public.sync_jobs
    set status           = 'queued',
        lease_expires_at = null,
        last_error       = 'Lease expirado: processo encerrado inesperadamente.',
        updated_at       = now()
    where status = 'running'
      and lease_expires_at < now();

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- 11. Concessão de Privilégios para as RPCs
revoke all on function public.registrar_job_sync(uuid, uuid) from public, anon;
revoke all on function public.adquirir_lease_job_sync(uuid, integer) from public, anon;
revoke all on function public.avancar_checkpoint_job_sync(uuid, jsonb) from public, anon;
revoke all on function public.concluir_job_sync(uuid, text, text) from public, anon;
revoke all on function public.liberar_leases_expirados_sync() from public, anon;

grant execute on function public.registrar_job_sync(uuid, uuid)          to authenticated, service_role, postgres;
grant execute on function public.adquirir_lease_job_sync(uuid, integer)  to service_role, postgres;
grant execute on function public.avancar_checkpoint_job_sync(uuid, jsonb) to service_role, postgres;
grant execute on function public.concluir_job_sync(uuid, text, text)      to service_role, postgres;
grant execute on function public.liberar_leases_expirados_sync()          to service_role, postgres;
