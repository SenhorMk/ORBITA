-- Ticket 07: harden registration/session/OAuth journeys against CSRF, replay and abuse.
-- Forward-only, metadata-only table creation. No existing rows are rewritten.

-- 1. Server-side, single-use Bling OAuth transaction store. The cookie only ever
--    carries this row's opaque id; the row itself binds the actor, organization,
--    provider and a hash of the CSRF state, and is consumed atomically once.
create table if not exists public.transacoes_oauth (
    id uuid primary key default gen_random_uuid(),
    actor_id uuid not null references auth.users(id) on delete cascade,
    organizacao_id uuid references public.organizacoes(id) on delete cascade,
    provedor text not null check (provedor in ('bling')),
    state_hash text not null,
    criado_em timestamptz not null default now(),
    expira_em timestamptz not null,
    consumido_em timestamptz,
    constraint transacoes_oauth_state_hash_key unique (state_hash),
    constraint transacoes_oauth_expira_apos_criado check (expira_em > criado_em)
);

create index if not exists transacoes_oauth_expira_em_idx
    on public.transacoes_oauth (expira_em)
    where consumido_em is null;

alter table public.transacoes_oauth enable row level security;
revoke all on public.transacoes_oauth from public, anon, authenticated;
grant select, insert, update, delete on public.transacoes_oauth to service_role;

-- Atomic compare-and-swap consumption: exactly one caller can consume a given
-- transaction id/state hash pair. Replays after consumption or expiry are denied
-- without mutating the row again.
create or replace function public.consumir_transacao_oauth(
    p_id uuid,
    p_state_hash text,
    p_agora timestamptz default now()
)
returns table (consumido boolean, actor_id uuid, organizacao_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_actor_id uuid;
    v_organizacao_id uuid;
begin
    if p_id is null or p_state_hash is null or length(p_state_hash) = 0 then
        raise exception 'Parametros de consumo invalidos' using errcode = '22023';
    end if;

    update public.transacoes_oauth as transacao
    set consumido_em = p_agora
    where transacao.id = p_id
      and transacao.state_hash = p_state_hash
      and transacao.consumido_em is null
      and transacao.expira_em > p_agora
    returning transacao.actor_id, transacao.organizacao_id
    into v_actor_id, v_organizacao_id;

    return query select v_actor_id is not null, v_actor_id, v_organizacao_id;
end;
$$;

revoke all on function public.consumir_transacao_oauth(uuid, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.consumir_transacao_oauth(uuid, text, timestamptz)
to service_role;

-- 2. Durable rate-limit counters keyed by "action:identifier". Sensitive endpoints
--    (registration, OAuth initiate/callback) must fail closed when this store is
--    unreachable, so it is a plain table + atomic RPC, not an in-memory fallback.
create table if not exists public.limite_taxa_tentativas (
    chave text primary key,
    contagem integer not null default 1 check (contagem > 0),
    janela_inicio timestamptz not null default now(),
    atualizado_em timestamptz not null default now()
);

alter table public.limite_taxa_tentativas enable row level security;
revoke all on public.limite_taxa_tentativas from public, anon, authenticated;
grant select, insert, update, delete on public.limite_taxa_tentativas to service_role;

create or replace function public.registrar_tentativa_limite_taxa(
    p_chave text,
    p_limite integer,
    p_janela_segundos integer,
    p_agora timestamptz default now()
)
returns table (permitido boolean, contagem integer, reset_em timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_contagem integer;
    v_janela_inicio timestamptz;
    v_janela interval;
begin
    if p_chave is null or length(p_chave) = 0 then
        raise exception 'Chave de limite de taxa invalida' using errcode = '22023';
    end if;
    if p_limite <= 0 or p_janela_segundos <= 0 then
        raise exception 'Parametros de limite de taxa invalidos' using errcode = '22023';
    end if;

    v_janela := make_interval(secs => p_janela_segundos);

    insert into public.limite_taxa_tentativas as tentativa (chave, contagem, janela_inicio, atualizado_em)
    values (p_chave, 1, p_agora, p_agora)
    on conflict (chave) do update
        set contagem = case
                when p_agora - tentativa.janela_inicio >= v_janela then 1
                else tentativa.contagem + 1
            end,
            janela_inicio = case
                when p_agora - tentativa.janela_inicio >= v_janela then p_agora
                else tentativa.janela_inicio
            end,
            atualizado_em = p_agora
    returning tentativa.contagem, tentativa.janela_inicio
    into v_contagem, v_janela_inicio;

    return query select v_contagem <= p_limite, v_contagem, v_janela_inicio + v_janela;
end;
$$;

revoke all on function public.registrar_tentativa_limite_taxa(text, integer, integer, timestamptz)
from public, anon, authenticated;
grant execute on function public.registrar_tentativa_limite_taxa(text, integer, integer, timestamptz)
to service_role;
