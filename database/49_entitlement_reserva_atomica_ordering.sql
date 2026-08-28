-- ============================================================================
-- 49_entitlement_reserva_atomica_ordering.sql
-- Ticket 13: Concluir planos, entitlements e ciclo de vida
--
-- Corrige duas lacunas reais identificadas na auditoria (docs/migrations/
-- ticket-13-entitlements-audit.md):
--   1. `aceitar_convite_organizacao` inseria em membros_organizacao sem checar
--      o limite do plano nem o status de ciclo de vida da organização — duas
--      aceitações concorrentes de convites distintos podiam ambas passar
--      quando restava apenas um slot (TOCTOU). Agora serializa por
--      pg_advisory_xact_lock(organizacao_id + ':membros') e recomputa a
--      contagem dentro do lock antes de inserir.
--   2. `atualizar_assinatura_stripe_atomica` aplicava qualquer payload de
--      webhook recebido, sem comparar ordering (versão/timestamp do provider)
--      contra o que já estava persistido — um evento entregue fora de ordem
--      podia regredir o estado. Agora guarda `ultimo_evento_versao`/
--      `ultimo_evento_ocorrido_em` e rejeita eventos mais antigos (SAFETY:
--      retorna jsonb com outcome explícito em vez de aplicar cegamente).
-- ============================================================================

-- 1. Colunas de ordering de eventos Stripe na assinatura (forward-only, nullable)
alter table public.assinaturas_organizacao
    add column if not exists ultimo_evento_provider_id text,
    add column if not exists ultimo_evento_versao bigint,
    add column if not exists ultimo_evento_ocorrido_em timestamptz;

-- 2. Reserva atômica de slot de membro no aceite de convite
create or replace function public.aceitar_convite_organizacao(
    p_token text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid;
    v_convite record;
    v_org_status text;
    v_limite_membros int;
    v_uso_atual int;
    v_ja_membro boolean;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Usuario nao autenticado para aceitar convite' using errcode = '42501';
    end if;

    -- Buscar e travar o registro do convite para garantir uso estritamente único
    select * into v_convite
    from public.convites_organizacao
    where token = p_token
    for update;

    if not found then
        raise exception 'Convite nao encontrado' using errcode = 'P0002';
    end if;

    if v_convite.status <> 'pending' then
        raise exception 'Convite ja utilizado ou revogado' using errcode = '22000';
    end if;

    if v_convite.expires_at < now() then
        update public.convites_organizacao
        set status = 'expired'
        where id = v_convite.id;

        raise exception 'Convite expirado' using errcode = '22000';
    end if;

    -- Serializa concorrencia por organizacao+recurso: duas aceitacoes de
    -- convites distintos disputando o ultimo slot de membro nao podem ambas
    -- passar a checagem de limite. O lock e liberado apenas ao fim da
    -- transacao (commit/rollback), garantindo exclusao mutua real.
    perform pg_advisory_xact_lock(hashtextextended(v_convite.organizacao_id::text || ':membros', 0));

    select status into v_org_status
    from public.organizacoes
    where id = v_convite.organizacao_id;

    if v_org_status is null then
        raise exception 'Organizacao do convite nao encontrada' using errcode = 'P0002';
    end if;

    if v_org_status in ('suspended', 'pending_deletion', 'deleted') then
        raise exception 'Operacao bloqueada: organizacao com status %', v_org_status using errcode = 'ORB01';
    end if;

    select exists (
        select 1 from public.membros_organizacao
        where organizacao_id = v_convite.organizacao_id and user_id = v_user_id
    ) into v_ja_membro;

    if not v_ja_membro then
        select coalesce((a.limites_customizados->>'limite_membros')::int, p.limite_membros)
          into v_limite_membros
          from public.assinaturas_organizacao a
          join public.planos p on p.id = a.plano_id
         where a.organizacao_id = v_convite.organizacao_id;

        if v_limite_membros is null then
            select limite_membros into v_limite_membros
            from public.planos where slug = 'starter';
        end if;

        select count(*) into v_uso_atual
        from public.membros_organizacao
        where organizacao_id = v_convite.organizacao_id;

        if v_uso_atual >= v_limite_membros then
            raise exception 'Limite de membros do plano atingido (%/%)', v_uso_atual, v_limite_membros
                using errcode = 'ORB02';
        end if;
    end if;

    -- Inserir ou atualizar membership com o papel pré-determinado pelo convite
    insert into public.membros_organizacao (
        organizacao_id,
        user_id,
        papel
    ) values (
        v_convite.organizacao_id,
        v_user_id,
        v_convite.papel
    )
    on conflict (organizacao_id, user_id)
    do update set papel = v_convite.papel;

    -- Marcar convite como aceito
    update public.convites_organizacao
    set status = 'accepted',
        accepted_at = now()
    where id = v_convite.id;

    return v_convite.organizacao_id;
end;
$$;

revoke all on function public.aceitar_convite_organizacao(text) from public, anon;
grant execute on function public.aceitar_convite_organizacao(text) to authenticated, service_role;

-- 3. Ordering de eventos Stripe: rejeita atualizações mais antigas que o já aplicado
drop function if exists public.atualizar_assinatura_stripe_atomica(
    uuid, text, text, text, text, text, text, timestamptz, text, jsonb
);

create function public.atualizar_assinatura_stripe_atomica(
    p_org_id uuid,
    p_plano_slug text,
    p_status text,
    p_customer_id text,
    p_subscription_id text,
    p_price_id text default null,
    p_intervalo text default 'monthly',
    p_periodo_fim timestamptz default null,
    p_motivo text default 'Sincronizacao de assinatura Stripe',
    p_metadata jsonb default '{}'::jsonb,
    p_event_versao bigint default null,
    p_event_ocorrido_em timestamptz default null
)
returns jsonb
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
    v_current_versao bigint;
    v_current_ocorrido_em timestamptz;
begin
    -- Trava a linha da assinatura (se existir) para serializar webhooks
    -- concorrentes do mesmo recurso e comparar ordering atomicamente.
    select ultimo_evento_versao, ultimo_evento_ocorrido_em
      into v_current_versao, v_current_ocorrido_em
      from public.assinaturas_organizacao
     where organizacao_id = p_org_id
     for update;

    if p_event_versao is not null and v_current_versao is not null and p_event_versao <= v_current_versao then
        return jsonb_build_object(
            'outcome', 'rejected_stale',
            'motivo', format('evento versao %s nao e mais recente que a versao ja aplicada %s', p_event_versao, v_current_versao)
        );
    end if;

    if p_event_ocorrido_em is not null and v_current_ocorrido_em is not null and p_event_ocorrido_em < v_current_ocorrido_em then
        return jsonb_build_object(
            'outcome', 'rejected_stale',
            'motivo', format('evento ocorrido em %s e anterior ao ultimo aplicado em %s', p_event_ocorrido_em, v_current_ocorrido_em)
        );
    end if;

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
        ultimo_evento_provider_id,
        ultimo_evento_versao,
        ultimo_evento_ocorrido_em,
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
        p_metadata->>'event_id',
        p_event_versao,
        p_event_ocorrido_em,
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
        ultimo_evento_provider_id = coalesce(excluded.ultimo_evento_provider_id, public.assinaturas_organizacao.ultimo_evento_provider_id),
        ultimo_evento_versao = coalesce(excluded.ultimo_evento_versao, public.assinaturas_organizacao.ultimo_evento_versao),
        ultimo_evento_ocorrido_em = coalesce(excluded.ultimo_evento_ocorrido_em, public.assinaturas_organizacao.ultimo_evento_ocorrido_em),
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

    return jsonb_build_object('outcome', 'applied', 'evento', v_evento);
end;
$$;

revoke all on function public.atualizar_assinatura_stripe_atomica(
    uuid, text, text, text, text, text, text, timestamptz, text, jsonb, bigint, timestamptz
) from public, anon;
grant execute on function public.atualizar_assinatura_stripe_atomica(
    uuid, text, text, text, text, text, text, timestamptz, text, jsonb, bigint, timestamptz
) to service_role;
