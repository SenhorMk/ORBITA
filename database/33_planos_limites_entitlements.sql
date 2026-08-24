-- ============================================================================
-- 33_planos_limites_entitlements.sql
-- Ticket 37: Criar planos, limites e entitlements
-- Modelagem de planos, assinaturas e histórico auditável de entitlements por organização
-- ============================================================================

-- 1. Tabela de Planos do Sistema
create table if not exists public.planos (
    id                      uuid primary key default gen_random_uuid(),
    nome                    text not null check (char_length(trim(nome)) >= 2),
    slug                    text not null unique check (char_length(trim(slug)) >= 2),
    limite_membros          int not null default 3 check (limite_membros > 0),
    limite_conexoes_bling   int not null default 1 check (limite_conexoes_bling >= 0),
    limite_conexoes_chatwoot int not null default 1 check (limite_conexoes_chatwoot >= 0),
    recursos                jsonb not null default '{}'::jsonb,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

drop trigger if exists tg_planos_updated_at on public.planos;
create trigger tg_planos_updated_at
    before update on public.planos
    for each row execute function public.fn_set_updated_at();

-- 2. Seed de Planos Padrão
insert into public.planos (nome, slug, limite_membros, limite_conexoes_bling, limite_conexoes_chatwoot, recursos)
values
    ('Starter', 'starter', 3, 1, 1, '{"export_relatorios": false, "suporte_prioritario": false}'::jsonb),
    ('Pro', 'pro', 10, 3, 3, '{"export_relatorios": true, "suporte_prioritario": true}'::jsonb),
    ('Enterprise', 'enterprise', 1000, 50, 50, '{"export_relatorios": true, "suporte_prioritario": true, "sla_dedicado": true}'::jsonb)
on conflict (slug) do update
set nome = excluded.nome,
    limite_membros = excluded.limite_membros,
    limite_conexoes_bling = excluded.limite_conexoes_bling,
    limite_conexoes_chatwoot = excluded.limite_conexoes_chatwoot,
    recursos = excluded.recursos,
    updated_at = now();

-- 3. Tabela de Assinaturas da Organização
create table if not exists public.assinaturas_organizacao (
    id                   uuid primary key default gen_random_uuid(),
    organizacao_id       uuid not null references public.organizacoes(id) on delete cascade,
    plano_id             uuid not null references public.planos(id),
    status               text not null default 'active' check (status in ('trial', 'active', 'past_due', 'canceled', 'incomplete')),
    limites_customizados jsonb default null,
    periodo_inicio       timestamptz not null default now(),
    periodo_fim          timestamptz,
    cancelado_em         timestamptz,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    constraint uq_assinatura_org unique (organizacao_id)
);

create index if not exists idx_assinaturas_org_plano on public.assinaturas_organizacao(plano_id);

drop trigger if exists tg_assinaturas_organizacao_updated_at on public.assinaturas_organizacao;
create trigger tg_assinaturas_organizacao_updated_at
    before update on public.assinaturas_organizacao
    for each row execute function public.fn_set_updated_at();

-- 4. Tabela de Histórico Auditável de Entitlements
create table if not exists public.historico_entitlements (
    id                 uuid primary key default gen_random_uuid(),
    organizacao_id     uuid not null references public.organizacoes(id) on delete cascade,
    evento             text not null check (evento in ('criacao_assinatura', 'upgrade_plano', 'downgrade_plano', 'alteracao_limite', 'cancelamento', 'reativacao')),
    plano_anterior_id  uuid references public.planos(id),
    novo_plano_id      uuid references public.planos(id),
    motivo             text,
    metadata           jsonb not null default '{}'::jsonb,
    created_at         timestamptz not null default now()
);

create index if not exists idx_historico_entitlements_org on public.historico_entitlements(organizacao_id, created_at desc);

-- 5. Função RPC para Obter Entitlements Efetivos da Organização
create or replace function public.obter_entitlements_organizacao(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_result jsonb;
begin
    if not (
        public.usuario_pertence_a_organizacao(p_org_id)
        or current_user in ('postgres', 'service_role')
    ) then
        raise exception 'Acesso negado aos entitlements da organizacao' using errcode = '42501';
    end if;

    select jsonb_build_object(
        'organizacao_id', a.organizacao_id,
        'plano_id', p.id,
        'plano_nome', p.nome,
        'plano_slug', p.slug,
        'status', a.status,
        'limite_membros', coalesce((a.limites_customizados->>'limite_membros')::int, p.limite_membros),
        'limite_conexoes_bling', coalesce((a.limites_customizados->>'limite_conexoes_bling')::int, p.limite_conexoes_bling),
        'limite_conexoes_chatwoot', coalesce((a.limites_customizados->>'limite_conexoes_chatwoot')::int, p.limite_conexoes_chatwoot),
        'recursos', p.recursos || coalesce(a.limites_customizados->'recursos', '{}'::jsonb),
        'periodo_inicio', a.periodo_inicio,
        'periodo_fim', a.periodo_fim
    )
    into v_result
    from public.assinaturas_organizacao a
    join public.planos p on p.id = a.plano_id
    where a.organizacao_id = p_org_id;

    if v_result is null then
        -- Fallback seguro para Starter caso assinatura não exista
        select jsonb_build_object(
            'organizacao_id', p_org_id,
            'plano_id', p.id,
            'plano_nome', p.nome,
            'plano_slug', p.slug,
            'status', 'trial',
            'limite_membros', p.limite_membros,
            'limite_conexoes_bling', p.limite_conexoes_bling,
            'limite_conexoes_chatwoot', p.limite_conexoes_chatwoot,
            'recursos', p.recursos,
            'periodo_inicio', now(),
            'periodo_fim', null
        )
        into v_result
        from public.planos p
        where p.slug = 'starter'
        limit 1;
    end if;

    return v_result;
end;
$$;

-- 6. Atualização da Função Atômica de Criação de Organização para Incluir Assinatura Starter
create or replace function public.criar_organizacao_atomica(
    p_nome text,
    p_slug text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid;
    v_org_id uuid;
    v_plano_starter_id uuid;
    v_clean_slug text;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Usuario nao autenticado para criar organizacao' using errcode = '42501';
    end if;

    if trim(p_nome) is null or char_length(trim(p_nome)) < 2 then
        raise exception 'Nome da organizacao deve ter no minimo 2 caracteres' using errcode = '22000';
    end if;

    v_clean_slug := lower(regexp_replace(trim(p_slug), '[^a-zA-Z0-9_-]', '-', 'g'));
    if char_length(v_clean_slug) < 2 then
        raise exception 'Slug invalido para a organizacao' using errcode = '22000';
    end if;

    -- Inserir organização
    insert into public.organizacoes (nome, slug)
    values (trim(p_nome), v_clean_slug)
    returning id into v_org_id;

    -- Inserir criador como owner da organização
    insert into public.membros_organizacao (organizacao_id, user_id, papel)
    values (v_org_id, v_user_id, 'owner');

    -- Obter plano Starter padrão
    select id into v_plano_starter_id
    from public.planos
    where slug = 'starter'
    limit 1;

    if v_plano_starter_id is not null then
        -- Criar assinatura ativa Starter
        insert into public.assinaturas_organizacao (organizacao_id, plano_id, status)
        values (v_org_id, v_plano_starter_id, 'active')
        on conflict (organizacao_id) do nothing;

        -- Registrar histórico auditável
        insert into public.historico_entitlements (organizacao_id, evento, novo_plano_id, motivo, metadata)
        values (
            v_org_id,
            'criacao_assinatura',
            v_plano_starter_id,
            'Assinatura Starter inicial atribuida na criacao da organizacao',
            jsonb_build_object('criador_user_id', v_user_id)
        );
    end if;

    return v_org_id;
end;
$$;

-- 7. Backfill Defensivo para Organizações Existentes sem Assinatura
do $$
declare
    v_starter_id uuid;
    r record;
begin
    select id into v_starter_id from public.planos where slug = 'starter' limit 1;
    if v_starter_id is not null then
        for r in
            select o.id from public.organizacoes o
            where not exists (
                select 1 from public.assinaturas_organizacao a where a.organizacao_id = o.id
            )
        loop
            insert into public.assinaturas_organizacao (organizacao_id, plano_id, status)
            values (r.id, v_starter_id, 'active')
            on conflict (organizacao_id) do nothing;

            insert into public.historico_entitlements (organizacao_id, evento, novo_plano_id, motivo)
            values (r.id, 'criacao_assinatura', v_starter_id, 'Backfill de assinatura starter para organizacao existente');
        end loop;
    end if;
end;
$$;

-- 8. Concessão de Privilégios Mínimos e RLS (OWASP ASVS L2)
revoke all on public.planos from public, anon;
revoke all on public.assinaturas_organizacao from public, anon;
revoke all on public.historico_entitlements from public, anon;
revoke all on function public.obter_entitlements_organizacao(uuid) from public, anon;

grant select on public.planos to authenticated, anon;
grant select on public.assinaturas_organizacao to authenticated;
grant select on public.historico_entitlements to authenticated;
grant all on public.planos to service_role;
grant all on public.assinaturas_organizacao to service_role;
grant all on public.historico_entitlements to service_role;
grant execute on function public.obter_entitlements_organizacao(uuid) to authenticated, service_role;

alter table public.planos enable row level security;
alter table public.assinaturas_organizacao enable row level security;
alter table public.historico_entitlements enable row level security;

-- Policies para Planos (Públicos para leitura)
drop policy if exists "Planos sao visiveis publicamente" on public.planos;
create policy "Planos sao visiveis publicamente"
    on public.planos
    for select
    using (true);

-- Policies para Assinaturas da Organização
drop policy if exists "Membros podem visualizar assinatura da sua organizacao" on public.assinaturas_organizacao;
create policy "Membros podem visualizar assinatura da sua organizacao"
    on public.assinaturas_organizacao
    for select
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

-- Policies para Histórico de Entitlements
drop policy if exists "Membros podem visualizar historico de entitlements da organizacao" on public.historico_entitlements;
create policy "Membros podem visualizar historico de entitlements da organizacao"
    on public.historico_entitlements
    for select
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));
