-- ============================================================================
-- 34_integrar_stripe_assinaturas.sql
-- Ticket 38: Integrar Stripe para assinatura e cobrança
-- Extensão de assinaturas com IDs Stripe e Inbox Idempotente de Webhooks
-- ============================================================================

-- 1. Extensão da tabela assinaturas_organizacao com dados de cobrança Stripe
alter table public.assinaturas_organizacao
    add column if not exists stripe_customer_id text,
    add column if not exists stripe_subscription_id text,
    add column if not exists stripe_price_id text,
    add column if not exists intervalo_cobranca text check (intervalo_cobranca in ('monthly', 'yearly'));

-- Índices únicos parciais para mapeamento seguro e busca rápida por webhook
create unique index if not exists uq_idx_assinaturas_stripe_customer
    on public.assinaturas_organizacao(stripe_customer_id)
    where stripe_customer_id is not null;

create unique index if not exists uq_idx_assinaturas_stripe_subscription
    on public.assinaturas_organizacao(stripe_subscription_id)
    where stripe_subscription_id is not null;

-- 2. Tabela de Inbox Idempotente de Webhooks do Stripe
create table if not exists public.stripe_webhook_events (
    id            text primary key, -- ID do evento no Stripe (ex: evt_1N...)
    tipo          text not null,
    status        text not null default 'pending' check (status in ('pending', 'processed', 'failed', 'ignored')),
    payload       jsonb not null,
    erro          text,
    processed_at  timestamptz,
    created_at    timestamptz not null default now()
);

create index if not exists idx_stripe_webhook_events_status
    on public.stripe_webhook_events(status, created_at desc);

-- 3. Função Atômica para Processar Assinatura do Stripe
create or replace function public.atualizar_assinatura_stripe_atomica(
    p_org_id uuid,
    p_plano_slug text,
    p_status text,
    p_customer_id text,
    p_subscription_id text,
    p_price_id text default null,
    p_intervalo text default 'monthly',
    p_periodo_fim timestamptz default null,
    p_motivo text default 'Sincronizacao de assinatura Stripe',
    p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_plano_id uuid;
    v_plano_anterior_id uuid;
    v_evento text;
    v_new_rank int;
    v_prev_rank int;
    v_prev_slug text;
begin
    -- Obter ID do novo plano
    select id into v_plano_id from public.planos where slug = p_plano_slug limit 1;
    if v_plano_id is null then
        raise exception 'Plano % nao encontrado', p_plano_slug using errcode = '22000';
    end if;

    -- Obter plano atual da assinatura
    select a.plano_id, p.slug into v_plano_anterior_id, v_prev_slug
    from public.assinaturas_organizacao a
    join public.planos p on p.id = a.plano_id
    where a.organizacao_id = p_org_id;

    -- Determinar tipo de evento
    if v_plano_anterior_id is null then
        v_evento := 'criacao_assinatura';
    elsif p_status = 'canceled' then
        v_evento := 'cancelamento';
    else
        v_new_rank := case p_plano_slug when 'enterprise' then 3 when 'pro' then 2 else 1 end;
        v_prev_rank := case v_prev_slug when 'enterprise' then 3 when 'pro' then 2 else 1 end;

        if v_new_rank >= v_prev_rank then
            v_evento := 'upgrade_plano';
        else
            v_evento := 'downgrade_plano';
        end if;
    end if;

    -- Upsert assinatura
    insert into public.assinaturas_organizacao (
        organizacao_id,
        plano_id,
        status,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_price_id,
        intervalo_cobranca,
        periodo_fim,
        updated_at
    )
    values (
        p_org_id,
        v_plano_id,
        p_status,
        p_customer_id,
        p_subscription_id,
        p_price_id,
        p_intervalo,
        p_periodo_fim,
        now()
    )
    on conflict (organizacao_id) do update
    set plano_id = excluded.plano_id,
        status = excluded.status,
        stripe_customer_id = coalesce(excluded.stripe_customer_id, public.assinaturas_organizacao.stripe_customer_id),
        stripe_subscription_id = coalesce(excluded.stripe_subscription_id, public.assinaturas_organizacao.stripe_subscription_id),
        stripe_price_id = coalesce(excluded.stripe_price_id, public.assinaturas_organizacao.stripe_price_id),
        intervalo_cobranca = coalesce(excluded.intervalo_cobranca, public.assinaturas_organizacao.intervalo_cobranca),
        periodo_fim = coalesce(excluded.periodo_fim, public.assinaturas_organizacao.periodo_fim),
        cancelado_em = case when excluded.status = 'canceled' then now() else null end,
        updated_at = now();

    -- Registrar histórico auditável de entitlements
    insert into public.historico_entitlements (
        organizacao_id,
        evento,
        plano_anterior_id,
        novo_plano_id,
        motivo,
        metadata
    )
    values (
        p_org_id,
        v_evento,
        v_plano_anterior_id,
        v_plano_id,
        p_motivo,
        p_metadata || jsonb_build_object(
            'stripe_customer_id', p_customer_id,
            'stripe_subscription_id', p_subscription_id,
            'stripe_status', p_status
        )
    );
end;
$$;

-- 4. Privilégios Mínimos e RLS (OWASP ASVS L2)
revoke all on public.stripe_webhook_events from public, anon, authenticated;
revoke all on function public.atualizar_assinatura_stripe_atomica(uuid, text, text, text, text, text, text, timestamptz, text, jsonb) from public, anon;

grant all on public.stripe_webhook_events to service_role;
grant execute on function public.atualizar_assinatura_stripe_atomica(uuid, text, text, text, text, text, text, timestamptz, text, jsonb) to service_role;

alter table public.stripe_webhook_events enable row level security;
-- Sem políticas para anon/authenticated: bloqueado 100% por padrão.
