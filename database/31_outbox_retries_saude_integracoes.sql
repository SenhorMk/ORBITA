-- ============================================================================
-- 31_outbox_retries_saude_integracoes.sql
-- Ticket 35: Adicionar outbox, retries e saúde das integrações
-- Persistência de efeitos externos, retry exponencial, dead letter e monitoramento de saúde
-- ============================================================================

-- 1. Evolução da Tabela de Conexões com Colunas de Saúde
alter table public.conexoes_integracao
    add column if not exists health_status text not null default 'healthy'
        check (health_status in ('healthy', 'degraded', 'disconnected', 'error')),
    add column if not exists last_health_check_at timestamptz,
    add column if not exists last_health_error text;

-- 2. Tabela de Outbox de Eventos / Efeitos Externos
create table if not exists public.outbox_eventos (
    id                   uuid primary key default gen_random_uuid(),
    organizacao_id       uuid not null references public.organizacoes(id) on delete cascade,
    conexao_id           uuid references public.conexoes_integracao(id) on delete set null,
    user_id              uuid references auth.users(id) on delete set null,
    idempotency_key      text not null,
    destination          text not null check (destination in ('chatwoot', 'bling', 'webhook_externo')),
    event_type           text not null,
    payload              jsonb not null,
    status               text not null default 'pending'
                         check (status in ('pending', 'processing', 'sent', 'failed_transient', 'dead_letter')),
    attempts             integer not null default 0,
    max_attempts         integer not null default 5,
    next_retry_at        timestamptz not null default now(),
    last_error           text,
    last_error_category  text check (last_error_category in ('transient', 'permanent', 'rate_limit', 'auth_expired')),
    response_body        jsonb,
    sent_at              timestamptz,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

-- 3. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
revoke all on public.outbox_eventos from public, anon;
grant select on public.outbox_eventos to authenticated;
grant all on public.outbox_eventos to service_role, postgres;

-- 4. Índices para Tenancy, Idempotência e Fila de Despacho
create unique index if not exists uq_outbox_eventos_org_key
    on public.outbox_eventos(organizacao_id, idempotency_key);

create index if not exists idx_outbox_eventos_dispatch
    on public.outbox_eventos(status, next_retry_at)
    where status in ('pending', 'failed_transient');

create index if not exists idx_outbox_eventos_org_status
    on public.outbox_eventos(organizacao_id, status, created_at desc);

create index if not exists idx_outbox_eventos_conexao
    on public.outbox_eventos(conexao_id);

-- 5. Trigger de updated_at
drop trigger if exists tg_outbox_eventos_updated_at on public.outbox_eventos;
create trigger tg_outbox_eventos_updated_at
    before update on public.outbox_eventos
    for each row execute function public.fn_set_updated_at();

-- 6. Isolamento por Row Level Security (RLS)
alter table public.outbox_eventos enable row level security;

drop policy if exists "Acesso a outbox_eventos por organizacao" on public.outbox_eventos;
create policy "Acesso a outbox_eventos por organizacao"
    on public.outbox_eventos
    for select
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

-- 7. RPC: Registrar Evento no Outbox (Idempotente)
create or replace function public.registrar_evento_outbox(
    p_organizacao_id   uuid,
    p_conexao_id       uuid,
    p_user_id          uuid,
    p_idempotency_key  text,
    p_destination      text,
    p_event_type       text,
    p_payload          jsonb,
    p_max_attempts     integer default 5
)
returns table (
    evento_id     uuid,
    status        text,
    is_duplicate  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existente record;
    v_new_id    uuid;
begin
    -- 1. Verificar idempotência por organização + chave
    select id, outbox_eventos.status into v_existente
    from public.outbox_eventos
    where organizacao_id = p_organizacao_id
      and idempotency_key = p_idempotency_key
    for update;

    if found then
        return query select v_existente.id, v_existente.status, true;
        return;
    end if;

    -- 2. Inserir novo evento no outbox com status 'pending'
    insert into public.outbox_eventos (
        organizacao_id,
        conexao_id,
        user_id,
        idempotency_key,
        destination,
        event_type,
        payload,
        status,
        max_attempts,
        next_retry_at
    ) values (
        p_organizacao_id,
        p_conexao_id,
        p_user_id,
        p_idempotency_key,
        p_destination,
        p_event_type,
        p_payload,
        'pending',
        coalesce(p_max_attempts, 5),
        now()
    )
    returning id into v_new_id;

    return query select v_new_id, 'pending'::text, false;
    return;
end;
$$;

-- 8. RPC: Reivindicar Lote de Eventos para Envio (FOR UPDATE SKIP LOCKED)
create or replace function public.reivindicar_lote_outbox(
    p_limit integer default 20
)
returns table (
    evento_id       uuid,
    organizacao_id  uuid,
    conexao_id      uuid,
    destination     text,
    event_type      text,
    payload         jsonb,
    attempts        integer,
    max_attempts    integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
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
        o.max_attempts;
end;
$$;

-- 9. RPC: Concluir Evento do Outbox com Classificação de Erro e Retry / Dead Letter
create or replace function public.concluir_evento_outbox(
    p_evento_id         uuid,
    p_status            text,
    p_response_body     jsonb default null,
    p_error             text default null,
    p_error_category    text default null,
    p_retry_delay_sec   integer default 10
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_evt record;
    v_new_status text;
    v_new_attempts integer;
begin
    select * into v_evt
    from public.outbox_eventos
    where id = p_evento_id;

    if not found then
        return;
    end if;

    v_new_attempts := v_evt.attempts + 1;

    if p_status = 'sent' then
        v_new_status := 'sent';
        update public.outbox_eventos
        set status = 'sent',
            response_body = p_response_body,
            last_error = null,
            last_error_category = null,
            sent_at = now(),
            attempts = v_new_attempts,
            updated_at = now()
        where id = p_evento_id;

        -- Conexão saudável
        if v_evt.conexao_id is not null then
            update public.conexoes_integracao
            set health_status = 'healthy',
                last_health_error = null,
                last_health_check_at = now()
            where id = v_evt.conexao_id;
        end if;

    elsif p_status = 'failed_transient' then
        -- Se atingiu limite de tentativas, vai para dead_letter
        if v_new_attempts >= v_evt.max_attempts then
            v_new_status := 'dead_letter';
            update public.outbox_eventos
            set status = 'dead_letter',
                last_error = p_error,
                last_error_category = p_error_category,
                attempts = v_new_attempts,
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
            -- Backoff exponencial seguro
            v_new_status := 'failed_transient';
            update public.outbox_eventos
            set status = 'failed_transient',
                last_error = p_error,
                last_error_category = p_error_category,
                attempts = v_new_attempts,
                next_retry_at = now() + (p_retry_delay_sec || ' seconds')::interval,
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
end;
$$;

-- 10. RPC: Atualização Direta de Saúde de Conexão
create or replace function public.atualizar_saude_conexao(
    p_conexao_id     uuid,
    p_health_status  text,
    p_error          text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.conexoes_integracao
    set health_status = p_health_status,
        last_health_error = p_error,
        last_health_check_at = now()
    where id = p_conexao_id;
end;
$$;

-- 11. Concessão de Privilégios para Funções RPC
revoke all on function public.registrar_evento_outbox(uuid, uuid, uuid, text, text, text, jsonb, integer) from public, anon;
revoke all on function public.reivindicar_lote_outbox(integer) from public, anon;
revoke all on function public.concluir_evento_outbox(uuid, text, jsonb, text, text, integer) from public, anon;
revoke all on function public.atualizar_saude_conexao(uuid, text, text) from public, anon;

grant execute on function public.registrar_evento_outbox(uuid, uuid, uuid, text, text, text, jsonb, integer) to authenticated, service_role, postgres;
grant execute on function public.reivindicar_lote_outbox(integer) to service_role, postgres;
grant execute on function public.concluir_evento_outbox(uuid, text, jsonb, text, text, integer) to service_role, postgres;
grant execute on function public.atualizar_saude_conexao(uuid, text, text) to authenticated, service_role, postgres;
