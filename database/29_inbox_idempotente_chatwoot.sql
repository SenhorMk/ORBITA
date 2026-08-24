-- ============================================================================
-- 29_inbox_idempotente_chatwoot.sql
-- Ticket 33: Persistir inbox idempotente para Chatwoot
-- Registro prévio de eventos, garantia de idempotência e suporte a replay seguro
-- ============================================================================

-- 1. Tabela de Inbox de Eventos do Chatwoot
create table if not exists public.inbox_eventos_chatwoot (
    id               uuid primary key default gen_random_uuid(),
    organizacao_id   uuid not null references public.organizacoes(id) on delete cascade,
    conexao_id       uuid references public.conexoes_integracao(id) on delete set null,
    user_id          uuid references auth.users(id) on delete set null,
    inbox_id         bigint,
    idempotency_key  text not null,
    event_type       text not null,
    payload          jsonb not null,
    status           text not null default 'received' check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
    attempts         integer not null default 0,
    last_error       text,
    response_body    jsonb,
    processed_at     timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

-- 2. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
revoke all on public.inbox_eventos_chatwoot from public, anon;
grant select on public.inbox_eventos_chatwoot to authenticated;
grant all on public.inbox_eventos_chatwoot to service_role, postgres;

-- 3. Índices de Tenancy, Idempotência e Consulta
create unique index if not exists uq_inbox_eventos_chatwoot_org_key
    on public.inbox_eventos_chatwoot(organizacao_id, idempotency_key);

create index if not exists idx_inbox_eventos_chatwoot_org_status
    on public.inbox_eventos_chatwoot(organizacao_id, status, created_at desc);

create index if not exists idx_inbox_eventos_chatwoot_conexao
    on public.inbox_eventos_chatwoot(conexao_id);

create index if not exists idx_inbox_eventos_chatwoot_user
    on public.inbox_eventos_chatwoot(user_id);

create index if not exists idx_inbox_eventos_chatwoot_inbox
    on public.inbox_eventos_chatwoot(inbox_id);

-- 4. Trigger de updated_at
drop trigger if exists tg_inbox_eventos_chatwoot_updated_at on public.inbox_eventos_chatwoot;
create trigger tg_inbox_eventos_chatwoot_updated_at
    before update on public.inbox_eventos_chatwoot
    for each row execute function public.fn_set_updated_at();

-- 5. Isolamento por Row Level Security (RLS)
alter table public.inbox_eventos_chatwoot enable row level security;

drop policy if exists "Acesso a inbox_eventos_chatwoot por organizacao" on public.inbox_eventos_chatwoot;
create policy "Acesso a inbox_eventos_chatwoot por organizacao"
    on public.inbox_eventos_chatwoot
    for all
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));

-- 6. RPC: Registro Atômico de Evento no Inbox (Reserva de Idempotência)
create or replace function public.registrar_evento_inbox_chatwoot(
    p_organizacao_id uuid,
    p_conexao_id uuid,
    p_user_id uuid,
    p_inbox_id bigint,
    p_idempotency_key text,
    p_event_type text,
    p_payload jsonb
)
returns table (
    evento_id uuid,
    status text,
    is_duplicate boolean,
    cached_response jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existente record;
    v_new_id uuid;
begin
    -- 1. Verificar se o evento já existe para a organização com lock exclusivo
    select id, inbox_eventos_chatwoot.status, response_body into v_existente
    from public.inbox_eventos_chatwoot
    where organizacao_id = p_organizacao_id
      and idempotency_key = p_idempotency_key
    for update;

    if found then
        -- Duplicata encontrada (já processada, em processamento ou com falha prévia)
        return query select v_existente.id, v_existente.status, true, v_existente.response_body;
        return;
    end if;

    -- 2. Inserir novo evento no inbox com status 'received'
    insert into public.inbox_eventos_chatwoot (
        organizacao_id,
        conexao_id,
        user_id,
        inbox_id,
        idempotency_key,
        event_type,
        payload,
        status,
        attempts
    ) values (
        p_organizacao_id,
        p_conexao_id,
        p_user_id,
        p_inbox_id,
        p_idempotency_key,
        p_event_type,
        p_payload,
        'received',
        0
    )
    returning id into v_new_id;

    return query select v_new_id, 'received'::text, false, null::jsonb;
    return;
end;
$$;

-- 7. RPC: Conclusão de Processamento de Evento no Inbox
create or replace function public.concluir_evento_inbox_chatwoot(
    p_evento_id uuid,
    p_status text,
    p_response_body jsonb default null,
    p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.inbox_eventos_chatwoot
    set status = p_status,
        response_body = case when p_status = 'processed' then p_response_body else response_body end,
        last_error = p_error,
        attempts = attempts + 1,
        processed_at = case when p_status in ('processed', 'ignored') then now() else processed_at end,
        updated_at = now()
    where id = p_evento_id;
end;
$$;

-- 8. RPC: Preparação de Replay para Eventos com Falha
create or replace function public.preparar_replay_evento_inbox_chatwoot(
    p_evento_id uuid
)
returns table (
    evento_id uuid,
    organizacao_id uuid,
    conexao_id uuid,
    user_id uuid,
    inbox_id bigint,
    event_type text,
    payload jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.inbox_eventos_chatwoot
    set status = 'processing',
        updated_at = now()
    where id = p_evento_id
    returning id, inbox_eventos_chatwoot.organizacao_id, inbox_eventos_chatwoot.conexao_id, inbox_eventos_chatwoot.user_id, inbox_eventos_chatwoot.inbox_id, inbox_eventos_chatwoot.event_type, inbox_eventos_chatwoot.payload
       into evento_id, organizacao_id, conexao_id, user_id, inbox_id, event_type, payload;

    return next;
    return;
end;
$$;

-- 9. Concessão de Privilégios para as Funções RPC
revoke all on function public.registrar_evento_inbox_chatwoot from public, anon;
revoke all on function public.concluir_evento_inbox_chatwoot from public, anon;
revoke all on function public.preparar_replay_evento_inbox_chatwoot from public, anon;

grant execute on function public.registrar_evento_inbox_chatwoot to authenticated, service_role, postgres;
grant execute on function public.concluir_evento_inbox_chatwoot to authenticated, service_role, postgres;
grant execute on function public.preparar_replay_evento_inbox_chatwoot to authenticated, service_role, postgres;
