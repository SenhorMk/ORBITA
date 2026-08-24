-- ============================================================================
-- 28_inbox_idempotente_bling.sql
-- Ticket 32: Persistir inbox idempotente para Bling
-- Registro prévio de eventos, garantia de idempotência e suporte a replay seguro
-- ============================================================================

-- 1. Tabela de Inbox de Eventos do Bling
create table if not exists public.inbox_eventos_bling (
    id               uuid primary key default gen_random_uuid(),
    organizacao_id   uuid not null references public.organizacoes(id) on delete cascade,
    conexao_id       uuid references public.conexoes_integracao(id) on delete set null,
    user_id          uuid references auth.users(id) on delete set null,
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
revoke all on public.inbox_eventos_bling from public, anon;
grant select on public.inbox_eventos_bling to authenticated;
grant all on public.inbox_eventos_bling to service_role, postgres;

-- 3. Índices de Tenancy, Idempotência e Consulta
create unique index if not exists uq_inbox_eventos_bling_org_key
    on public.inbox_eventos_bling(organizacao_id, idempotency_key);

create index if not exists idx_inbox_eventos_bling_org_status
    on public.inbox_eventos_bling(organizacao_id, status, created_at desc);

create index if not exists idx_inbox_eventos_bling_conexao
    on public.inbox_eventos_bling(conexao_id);

create index if not exists idx_inbox_eventos_bling_user
    on public.inbox_eventos_bling(user_id);

-- 4. Trigger de updated_at
drop trigger if exists tg_inbox_eventos_bling_updated_at on public.inbox_eventos_bling;
create trigger tg_inbox_eventos_bling_updated_at
    before update on public.inbox_eventos_bling
    for each row execute function public.fn_set_updated_at();

-- 5. Isolamento por Row Level Security (RLS)
alter table public.inbox_eventos_bling enable row level security;

drop policy if exists "Acesso a inbox_eventos_bling por organizacao" on public.inbox_eventos_bling;
create policy "Acesso a inbox_eventos_bling por organizacao"
    on public.inbox_eventos_bling
    for all
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));

-- 6. RPC: Registro Atômico de Evento no Inbox (Reserva de Idempotência)
create or replace function public.registrar_evento_inbox_bling(
    p_organizacao_id uuid,
    p_conexao_id uuid,
    p_user_id uuid,
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
    -- 1. Verificar se o evento já existe para a organização
    select id, inbox_eventos_bling.status, response_body into v_existente
    from public.inbox_eventos_bling
    where organizacao_id = p_organizacao_id
      and idempotency_key = p_idempotency_key
    for update;

    if found then
        -- Duplicata encontrada (já processada, em processamento ou com falha prévia)
        return query select v_existente.id, v_existente.status, true, v_existente.response_body;
        return;
    end if;

    -- 2. Inserir novo evento no inbox com status 'received'
    insert into public.inbox_eventos_bling (
        organizacao_id,
        conexao_id,
        user_id,
        idempotency_key,
        event_type,
        payload,
        status,
        attempts
    ) values (
        p_organizacao_id,
        p_conexao_id,
        p_user_id,
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
create or replace function public.concluir_evento_inbox_bling(
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
    update public.inbox_eventos_bling
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
create or replace function public.preparar_replay_evento_inbox_bling(
    p_evento_id uuid
)
returns table (
    evento_id uuid,
    organizacao_id uuid,
    conexao_id uuid,
    user_id uuid,
    event_type text,
    payload jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.inbox_eventos_bling
    set status = 'processing',
        updated_at = now()
    where id = p_evento_id
    returning id, inbox_eventos_bling.organizacao_id, inbox_eventos_bling.conexao_id, inbox_eventos_bling.user_id, inbox_eventos_bling.event_type, inbox_eventos_bling.payload
       into evento_id, organizacao_id, conexao_id, user_id, event_type, payload;

    return next;
    return;
end;
$$;

-- 9. Concessão de Privilégios para as Funções RPC
revoke all on function public.registrar_evento_inbox_bling from public, anon;
revoke all on function public.concluir_evento_inbox_bling from public, anon;
revoke all on function public.preparar_replay_evento_inbox_bling from public, anon;

grant execute on function public.registrar_evento_inbox_bling to authenticated, service_role, postgres;
grant execute on function public.concluir_evento_inbox_bling to authenticated, service_role, postgres;
grant execute on function public.preparar_replay_evento_inbox_bling to authenticated, service_role, postgres;
