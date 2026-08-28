-- ============================================================================
-- 52_auditoria_anti_forjamento_catalogo.sql
-- Ticket 19: Auditoria e resposta a incidentes
--
-- Fecha o gap crítico de anti-forjamento identificado na migration 36:
-- `registrar_evento_auditoria` fazia `coalesce(p_actor_id, auth.uid())` e nunca
-- validava que `p_actor_id`/`p_org_id` formavam um par de membership real. A
-- migration 37 (ticket 05) já havia restringido EXECUTE desta função a
-- `service_role` apenas (é infraestrutura server-only, como as demais RPCs de
-- inbox/outbox/job da mesma allowlist) — ou seja, nenhum navegador jamais chama
-- esta RPC diretamente; o ator/organização de um evento de usuário já vêm de
-- `VerifiedOrganizationScope` verificado em `auditService.recordAuditEvent`
-- antes de chegar aqui. Mesmo assim, um bug futuro na camada de aplicação (ou
-- qualquer código server-side com acesso à service role key) ainda podia montar
-- um par `p_actor_id`/`p_org_id` que nunca existiu — a RPC nunca revalidava.
--
-- Esta migration substitui (create or replace, mesma assinatura — nenhum caller
-- de aplicação muda) a função para revalidar escopo internamente como última
-- linha de defesa:
--   - qualquer papel que não seja `service_role` é rejeitado antes de qualquer
--     outra checagem (mantém a restrição já decidida na migration 37);
--   - quando `p_org_id` é informado, a organização precisa existir;
--   - quando `p_actor_id` é informado, ele precisa ser membro de `p_org_id`
--     (que passa a ser obrigatório nesse caso) — impede atribuir um evento a um
--     ator que nunca pertenceu à organização, mesmo vindo de `service_role`;
--   - `p_actor_id` nulo permanece válido para eventos de sistema sem ator humano.
--
-- Também adiciona uma tabela de referência para o catálogo versionado de
-- eventos de auditoria (a fonte de verdade executável do catálogo é
-- `src/lib/observability/auditEventCatalog.ts`; esta tabela é uma projeção
-- consultável em SQL/relatórios, não substitui a validação de aplicação).
-- Forward-only: nenhuma coluna/linha existente é removida ou renomeada.
-- ============================================================================

-- 1. Tabela de referência do catálogo de eventos (projeção consultável)
create table if not exists public.catalogo_eventos_auditoria (
    nome            text primary key,
    versao          integer not null default 1,
    produtor        text not null,
    severidade      text not null check (severidade in ('info', 'warning', 'critical')),
    ator_esperado   text not null check (ator_esperado in ('user', 'system')),
    retention_dias  integer not null check (retention_dias > 0),
    alerta_regra    text,
    descricao       text not null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

revoke all on public.catalogo_eventos_auditoria from public, anon;
grant select on public.catalogo_eventos_auditoria to authenticated, service_role;
grant all on public.catalogo_eventos_auditoria to service_role;

alter table public.catalogo_eventos_auditoria enable row level security;

drop policy if exists "Catalogo de eventos e legivel por autenticados" on public.catalogo_eventos_auditoria;
create policy "Catalogo de eventos e legivel por autenticados"
    on public.catalogo_eventos_auditoria
    for select
    to authenticated
    using (true);

insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('auth.login_failed', 1, 'auth', 'warning', 'user', 400, 'authFailureBurst', 'Tentativa de login com credenciais inválidas.'),
    ('auth.login_success', 1, 'auth', 'info', 'user', 400, null, 'Login bem-sucedido de um usuário.'),
    ('auth.password_reset_requested', 1, 'auth', 'info', 'user', 400, null, 'Solicitação de redefinição de senha.'),
    ('auth.api_key_created', 1, 'auth', 'warning', 'user', 1825, null, 'Criação de uma nova chave de API.'),
    ('auth.session_revoked', 1, 'auth', 'warning', 'system', 400, null, 'Sessão revogada por segurança.'),
    ('membership.member_invited', 1, 'organization', 'info', 'user', 730, null, 'Convite de novo membro para a organização.'),
    ('membership.member_removed', 1, 'organization', 'warning', 'user', 730, null, 'Remoção de membro da organização.'),
    ('membership.role_changed', 1, 'organization', 'warning', 'user', 730, null, 'Alteração de papel (role) de um membro.'),
    ('capability.granted', 1, 'organization', 'warning', 'user', 730, null, 'Capacidade privilegiada concedida a um membro.'),
    ('capability.revoked', 1, 'organization', 'info', 'user', 730, null, 'Capacidade privilegiada revogada de um membro.'),
    ('billing.owner_changed', 1, 'billing', 'critical', 'user', 1825, 'ownerOrBillingChange', 'Troca do titular (owner) da organização.'),
    ('billing.plan_changed', 1, 'billing', 'warning', 'user', 1825, 'ownerOrBillingChange', 'Alteração de plano/assinatura da organização.'),
    ('billing.payment_method_changed', 1, 'billing', 'warning', 'user', 1825, 'ownerOrBillingChange', 'Alteração do método de pagamento associado.'),
    ('oauth.token_issued', 1, 'integrations', 'info', 'system', 400, null, 'Token OAuth emitido/renovado para um provider externo.'),
    ('oauth.token_revoked', 1, 'integrations', 'warning', 'system', 400, null, 'Token OAuth revogado ou expirado sem renovação.'),
    ('webhook.signature_invalid', 1, 'integrations', 'critical', 'system', 400, 'invalidWebhookSignature', 'Webhook recebido com assinatura inválida.'),
    ('webhook.replay_detected', 1, 'integrations', 'warning', 'system', 400, null, 'Webhook duplicado detectado pela idempotência do inbox.'),
    ('job.dead_letter', 1, 'jobs', 'critical', 'system', 400, 'deadLetter', 'Job/evento de outbox esgotou tentativas e foi para dead-letter.'),
    ('job.lease_expired_recovered', 1, 'jobs', 'warning', 'system', 400, null, 'Lease de worker expirado recuperado pelo reaper.'),
    ('privacy.export_requested', 1, 'privacy', 'info', 'user', 1825, null, 'Titular solicitou exportação dos próprios dados.'),
    ('privacy.export_completed', 1, 'privacy', 'info', 'system', 1825, null, 'Exportação de dados do titular concluída.'),
    ('privacy.delete_requested', 1, 'privacy', 'warning', 'user', 1825, null, 'Titular solicitou eliminação dos próprios dados.'),
    ('privacy.delete_completed', 1, 'privacy', 'warning', 'system', 1825, null, 'Eliminação/anonimização de dados do titular concluída.'),
    ('security.cross_tenant_attempt', 1, 'security', 'critical', 'system', 1825, 'crossTenantAttempt', 'Tentativa de acesso/gravação em organização diferente do escopo verificado.'),
    ('org.privileged_change', 1, 'organization', 'warning', 'user', 1825, null, 'Alteração de configuração privilegiada da organização.'),
    ('org.migration_readiness_failed', 1, 'platform', 'critical', 'system', 400, 'migrationReadiness', 'Checagem de readiness/migration falhou.')
on conflict (nome) do nothing;

-- 2. Endurecimento anti-forjamento da RPC de registro de auditoria
create or replace function public.registrar_evento_auditoria(
    p_org_id uuid,
    p_actor_id uuid,
    p_acao text,
    p_recurso text,
    p_recurso_id text default null,
    p_correlation_id text default null,
    p_ip_address text default null,
    p_user_agent text default null,
    p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_event_id uuid;
    v_caller_role text;
    v_is_member boolean;
    v_org_exists boolean;
begin
    v_caller_role := coalesce(auth.role(), 'anon');

    -- Ticket 05 (migration 37) já revogou EXECUTE de `authenticated` nesta função — ela é
    -- infraestrutura server-only, como as demais RPCs de inbox/outbox/job da mesma
    -- allowlist (`catalog_security.test.sql`). O ator e a organização de todo evento de
    -- usuário já são derivados de `VerifiedOrganizationScope` na camada de aplicação
    -- (`auditService.recordAuditEvent`) antes de chegar aqui — nunca de input direto do
    -- navegador. Esta função só aceita `service_role`, e revalida internamente mesmo
    -- assim: é a última linha de defesa contra um bug futuro na camada de aplicação que
    -- tente atribuir um `p_actor_id`/`p_org_id` que não formam um par real de membership.
    if v_caller_role <> 'service_role' then
        raise exception 'Papel % não tem autorização para registrar eventos de auditoria — RPC restrita a service_role', v_caller_role;
    end if;

    if p_org_id is not null then
        select exists (
            select 1 from public.organizacoes o where o.id = p_org_id
        ) into v_org_exists;

        if not v_org_exists then
            raise exception 'Organização % informada não existe — evento de auditoria recusado', p_org_id;
        end if;
    end if;

    if p_actor_id is not null then
        if p_org_id is null then
            raise exception 'p_org_id é obrigatório quando um ator é atribuído ao evento de auditoria';
        end if;

        select exists (
            select 1
            from public.membros_organizacao m
            where m.organizacao_id = p_org_id
              and m.user_id = p_actor_id
        ) into v_is_member;

        if not v_is_member then
            raise exception 'Ator % não pertence à organização % — evento de auditoria recusado (anti-forjamento cross-tenant)',
                p_actor_id, p_org_id;
        end if;
    end if;

    insert into public.eventos_auditoria_sistema (
        organizacao_id,
        actor_id,
        acao,
        recurso,
        recurso_id,
        correlation_id,
        ip_address,
        user_agent,
        metadata
    ) values (
        p_org_id,
        p_actor_id,
        trim(p_acao),
        trim(p_recurso),
        p_recurso_id,
        p_correlation_id,
        p_ip_address,
        p_user_agent,
        coalesce(p_metadata, '{}'::jsonb)
    )
    returning id into v_event_id;

    return v_event_id;
end;
$$;

-- A migration 37 (ticket 05) já revogou EXECUTE de `authenticated` nesta função — mantida
-- infraestrutura server-only, junto das demais RPCs de inbox/outbox/job. Reafirmar apenas
-- `service_role` (nunca reconceder a `authenticated`) para o caso de ter sido revogada
-- manualmente; `postgres` mantém acesso por ser o dono da função.
revoke all on function public.registrar_evento_auditoria(uuid, uuid, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.registrar_evento_auditoria(uuid, uuid, text, text, text, text, text, text, jsonb) to service_role;
