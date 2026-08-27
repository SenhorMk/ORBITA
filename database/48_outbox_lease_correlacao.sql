-- ============================================================================
-- 48_outbox_lease_correlacao.sql
-- Ticket 12: Concluir inbox, outbox e jobs duráveis
--
-- Fecha o gap crítico da auditoria (docs/migrations/ticket-12-durability-audit.md):
-- `reivindicar_lote_outbox` movia eventos para 'processing' sem lease
-- (owner/expiração). Um worker que morresse após reivindicar um lote perdia
-- o evento em silêncio para sempre — nunca mais era reprocessado nem caía em
-- dead_letter. Este arquivo:
--   1. adiciona lease_owner/lease_expires_at a outbox_eventos, no mesmo
--      padrão já usado em sync_jobs (28/29/30/31 auditados, nenhum recriado);
--   2. adiciona correlation_id nullable às quatro tabelas de durabilidade
--      para permitir correlação request/webhook -> inbox -> job -> outbox;
--   3. substitui (create or replace) reivindicar_lote_outbox e
--      concluir_evento_outbox para gravar/exigir o lease, sem alterar a
--      tabela em modo destrutivo;
--   4. adiciona o reaper liberar_leases_expirados_outbox(), simétrico ao já
--      existente liberar_leases_expirados_sync().
-- Forward-only: nenhuma coluna existente é removida ou renomeada.
-- ============================================================================

-- 1. Lease owner/expiração no outbox (mesma semântica de sync_jobs.lease_expires_at)
alter table public.outbox_eventos
    add column if not exists lease_owner text,
    add column if not exists lease_expires_at timestamptz;

-- 2. correlation_id nullable nas quatro tabelas de durabilidade
alter table public.inbox_eventos_bling
    add column if not exists correlation_id text;

alter table public.inbox_eventos_chatwoot
    add column if not exists correlation_id text;

alter table public.sync_jobs
    add column if not exists correlation_id text;

alter table public.outbox_eventos
    add column if not exists correlation_id text;

-- 3. Índice para o reaper de lease expirado (mesmo padrão de idx_sync_jobs_lease)
create index if not exists idx_outbox_eventos_lease
    on public.outbox_eventos(lease_expires_at)
    where status = 'processing';

-- 4. RPC: Reivindicar Lote de Eventos para Envio, agora com lease owner/expiração
--    Substitui a versão da migration 31: mesmo predicado FOR UPDATE SKIP LOCKED,
--    mesmo limite de lote; adiciona p_worker_id/p_lease_ttl_sec e retorna
--    lease_expires_at para o worker poder renovar/checar antes de concluir.
drop function if exists public.reivindicar_lote_outbox(integer);

create or replace function public.reivindicar_lote_outbox(
    p_worker_id      text,
    p_limit          integer default 20,
    p_lease_ttl_sec  integer default 300
)
returns table (
    evento_id         uuid,
    organizacao_id    uuid,
    conexao_id        uuid,
    destination       text,
    event_type        text,
    payload           jsonb,
    attempts          integer,
    max_attempts      integer,
    lease_owner       text,
    lease_expires_at  timestamptz,
    correlation_id    text
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_worker_id is null or length(trim(p_worker_id)) = 0 then
        raise exception 'p_worker_id é obrigatório para reivindicar lote do outbox';
    end if;

    return query
    with lote as (
        select id
        from public.outbox_eventos
        where status in ('pending', 'failed_transient')
          and next_retry_at <= now()
        order by next_retry_at asc
        limit p_limit
        for update skip locked
    )
    update public.outbox_eventos o
    set status = 'processing',
        lease_owner = p_worker_id,
        lease_expires_at = now() + (p_lease_ttl_sec || ' seconds')::interval,
        updated_at = now()
    from lote
    where o.id = lote.id
    returning
        o.id,
        o.organizacao_id,
        o.conexao_id,
        o.destination,
        o.event_type,
        o.payload,
        o.attempts,
        o.max_attempts,
        o.lease_owner,
        o.lease_expires_at,
        o.correlation_id;
end;
$$;

-- 5. RPC: Concluir Evento do Outbox — agora exige posse do lease vigente.
--    Um worker cujo lease expirou (ou que nunca reivindicou o evento) não
--    consegue mais aplicar sent/failed/dead_letter: a chamada é um no-op
--    auditável (retorna false), nunca duplica o efeito de outro worker que
--    já retomou o mesmo evento.
drop function if exists public.concluir_evento_outbox(uuid, text, jsonb, text, text, integer);

create or replace function public.concluir_evento_outbox(
    p_evento_id         uuid,
    p_worker_id         text,
    p_status            text,
    p_response_body     jsonb default null,
    p_error             text default null,
    p_error_category    text default null,
    p_retry_delay_sec   integer default 10
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_evt record;
    v_new_attempts integer;
begin
    select * into v_evt
    from public.outbox_eventos
    where id = p_evento_id
    for update;

    if not found then
        return false;
    end if;

    -- Um evento já terminal (sent/dead_letter) ou já reaproveitado pelo
    -- reaper/backoff (failed_transient — só reivindicável via
    -- reivindicar_lote_outbox de novo) nunca aceita uma nova conclusão: é
    -- assim que um worker zumbi é impedido de aplicar o efeito duas vezes
    -- depois que outro processo (worker ou o próprio reaper) já assumiu o
    -- evento.
    if v_evt.status in ('sent', 'dead_letter', 'failed_transient') then
        return false;
    end if;

    -- 'pending' (nunca reivindicado — caminho de envio síncrono inline, sem
    -- lease) é aceito sem checar dono. 'processing' exige posse do lease
    -- vigente do chamador; outro dono ou lease expirado é rejeitado.
    if v_evt.status = 'processing'
       and (v_evt.lease_owner is distinct from p_worker_id
            or v_evt.lease_expires_at is null
            or v_evt.lease_expires_at < now()) then
        return false;
    end if;

    v_new_attempts := v_evt.attempts + 1;

    if p_status = 'sent' then
        update public.outbox_eventos
        set status = 'sent',
            response_body = p_response_body,
            last_error = null,
            last_error_category = null,
            sent_at = now(),
            attempts = v_new_attempts,
            lease_owner = null,
            lease_expires_at = null,
            updated_at = now()
        where id = p_evento_id;

        if v_evt.conexao_id is not null then
            update public.conexoes_integracao
            set health_status = 'healthy',
                last_health_error = null,
                last_health_check_at = now()
            where id = v_evt.conexao_id;
        end if;

    elsif p_status = 'failed_transient' then
        if v_new_attempts >= v_evt.max_attempts then
            update public.outbox_eventos
            set status = 'dead_letter',
                last_error = p_error,
                last_error_category = p_error_category,
                attempts = v_new_attempts,
                lease_owner = null,
                lease_expires_at = null,
                updated_at = now()
            where id = p_evento_id;

            if v_evt.conexao_id is not null then
                update public.conexoes_integracao
                set health_status = 'error',
                    last_health_error = p_error,
                    last_health_check_at = now()
                where id = v_evt.conexao_id;
            end if;
        else
            update public.outbox_eventos
            set status = 'failed_transient',
                last_error = p_error,
                last_error_category = p_error_category,
                attempts = v_new_attempts,
                next_retry_at = now() + (p_retry_delay_sec || ' seconds')::interval,
                lease_owner = null,
                lease_expires_at = null,
                updated_at = now()
            where id = p_evento_id;

            if v_evt.conexao_id is not null then
                update public.conexoes_integracao
                set health_status = 'degraded',
                    last_health_error = p_error,
                    last_health_check_at = now()
                where id = v_evt.conexao_id;
            end if;
        end if;

    else -- 'dead_letter' ou permanente
        update public.outbox_eventos
        set status = 'dead_letter',
            last_error = p_error,
            last_error_category = coalesce(p_error_category, 'permanent'),
            attempts = v_new_attempts,
            lease_owner = null,
            lease_expires_at = null,
            updated_at = now()
        where id = p_evento_id;

        if v_evt.conexao_id is not null then
            update public.conexoes_integracao
            set health_status = case when p_error_category = 'auth_expired' then 'disconnected' else 'error' end,
                last_health_error = p_error,
                last_health_check_at = now()
            where id = v_evt.conexao_id;
        end if;
    end if;

    return true;
end;
$$;

-- 6. RPC: Recuperação de crash do outbox — libera leases expirados.
--    Simétrico a liberar_leases_expirados_sync() (migration 30). Um evento
--    preso em 'processing' com lease vencido volta a 'pending' se ainda tem
--    tentativas disponíveis, ou vai a 'dead_letter' se já esgotou
--    max_attempts — nunca fica preso indefinidamente e nunca reinicia a
--    contagem de tentativas.
create or replace function public.liberar_leases_expirados_outbox()
returns table (
    evento_id       uuid,
    novo_status     text
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row record;
    v_new_attempts integer;
    v_new_status text;
begin
    for v_row in
        select *
        from public.outbox_eventos
        where status = 'processing'
          and lease_expires_at is not null
          and lease_expires_at < now()
        for update skip locked
    loop
        v_new_attempts := v_row.attempts + 1;
        if v_new_attempts >= v_row.max_attempts then
            v_new_status := 'dead_letter';
            update public.outbox_eventos
            set status = 'dead_letter',
                attempts = v_new_attempts,
                last_error = coalesce(last_error, 'Lease expirado: worker encerrado inesperadamente.'),
                last_error_category = coalesce(last_error_category, 'transient'),
                lease_owner = null,
                lease_expires_at = null,
                updated_at = now()
            where id = v_row.id;
        else
            v_new_status := 'failed_transient';
            update public.outbox_eventos
            set status = 'failed_transient',
                attempts = v_new_attempts,
                last_error = 'Lease expirado: worker encerrado inesperadamente.',
                last_error_category = 'transient',
                next_retry_at = now(),
                lease_owner = null,
                lease_expires_at = null,
                updated_at = now()
            where id = v_row.id;
        end if;

        evento_id := v_row.id;
        novo_status := v_new_status;
        return next;
    end loop;
    return;
end;
$$;

-- 7. Concessão de Privilégios para as Novas/Alteradas RPCs
revoke all on function public.reivindicar_lote_outbox(text, integer, integer) from public, anon;
revoke all on function public.concluir_evento_outbox(uuid, text, text, jsonb, text, text, integer) from public, anon;
revoke all on function public.liberar_leases_expirados_outbox() from public, anon;

grant execute on function public.reivindicar_lote_outbox(text, integer, integer) to service_role, postgres;
grant execute on function public.concluir_evento_outbox(uuid, text, text, jsonb, text, text, integer) to service_role, postgres;
grant execute on function public.liberar_leases_expirados_outbox() to service_role, postgres;
