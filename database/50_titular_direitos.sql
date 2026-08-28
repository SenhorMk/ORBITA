-- ============================================================================
-- 50_titular_direitos.sql
-- Ticket 17: Implementar direitos do titular (LGPD)
--
-- Jornada auditável para receber, verificar, executar e responder
-- solicitações de titulares. Forward-only: cria tabelas novas, não altera
-- nenhuma tabela existente. Ver docs/adr/ticket-17-direitos-titular.md.
--
--   1. titular_solicitacoes            - a solicitação em si (máquina de estados)
--   2. titular_solicitacao_verificacoes - desafios de verificação de identidade
--   3. titular_solicitacao_tarefas      - uma tarefa por sistema alcançado (banco/bling/chatwoot/stripe/logs)
--   4. titular_solicitacao_historico    - trilha de auditoria append-only
--   5. titular_exportacoes              - metadados de arquivo de exportação cifrado/expirável
--
-- Autoridade: toda escrita passa por RPC security definer chamada apenas
-- pela camada de aplicação (service_role); RLS nas tabelas restringe leitura
-- direta a owner/admin da própria organização (defesa em profundidade).
-- ============================================================================

-- 1. Tabela principal da solicitação
create table if not exists public.titular_solicitacoes (
    id                       uuid primary key default gen_random_uuid(),
    organizacao_id           uuid not null references public.organizacoes(id) on delete cascade,
    titular_tipo             text not null check (titular_tipo in ('lojista_user', 'cliente_final')),
    titular_ref_user_id      uuid null,
    titular_ref_cliente_id   uuid null references public.clientes(id) on delete restrict,
    titular_contato_cifrado  text null,
    tipo_direito             text not null check (tipo_direito in ('acesso', 'exportacao', 'correcao', 'exclusao')),
    canal                    text not null default 'web',
    estado                   text not null default 'received' check (estado in (
                                  'received', 'identity_pending', 'verified', 'in_review',
                                  'approved', 'partially_denied', 'denied',
                                  'executing', 'completed', 'failed'
                              )),
    versao                   integer not null default 0,
    sla_vencimento           timestamptz not null,
    idempotency_key          text not null,
    correlation_id           text,
    metadata                 jsonb not null default '{}'::jsonb,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),
    constraint chk_titular_ref_presente check (
        (titular_tipo = 'lojista_user' and titular_ref_user_id is not null)
        or (titular_tipo = 'cliente_final' and titular_ref_cliente_id is not null)
    )
);

-- Idempotência: mesma organização + mesma chave de idempotência (calculada pela
-- aplicação a partir de titular+tipo_direito+janela) nunca cria duas linhas.
create unique index if not exists uq_titular_solicitacoes_idempotency
    on public.titular_solicitacoes(organizacao_id, idempotency_key);

create index if not exists idx_titular_solicitacoes_org_estado
    on public.titular_solicitacoes(organizacao_id, estado);

create index if not exists idx_titular_solicitacoes_cliente
    on public.titular_solicitacoes(titular_ref_cliente_id)
    where titular_ref_cliente_id is not null;

create index if not exists idx_titular_solicitacoes_user
    on public.titular_solicitacoes(titular_ref_user_id)
    where titular_ref_user_id is not null;

-- 2. Desafios de verificação de identidade. Nunca guarda o código em texto
--    plano — apenas o hash — e nunca aceita e-mail/documento isolado como
--    prova (o `metodo` explicita o mecanismo usado).
create table if not exists public.titular_solicitacao_verificacoes (
    id                uuid primary key default gen_random_uuid(),
    solicitacao_id    uuid not null references public.titular_solicitacoes(id) on delete cascade,
    metodo            text not null check (metodo in ('sessao_forte', 'codigo_pedido')),
    codigo_hash       text null,
    tentativas        integer not null default 0,
    max_tentativas    integer not null default 5,
    expira_em         timestamptz not null,
    verificado_em     timestamptz null,
    created_at        timestamptz not null default now()
);

create index if not exists idx_titular_verificacoes_solicitacao
    on public.titular_solicitacao_verificacoes(solicitacao_id);

-- 3. Uma tarefa por sistema alcançado. `outbox_evento_id` correlaciona com o
--    outbox durável (ticket 12) quando o sistema é um provider externo.
create table if not exists public.titular_solicitacao_tarefas (
    id                uuid primary key default gen_random_uuid(),
    solicitacao_id    uuid not null references public.titular_solicitacoes(id) on delete cascade,
    sistema           text not null check (sistema in ('banco', 'bling', 'chatwoot', 'stripe', 'logs')),
    status            text not null default 'pending' check (status in (
                          'pending', 'completed', 'not_found', 'retained_with_reason', 'retryable', 'failed'
                      )),
    fundamento        text null,
    outbox_evento_id  uuid null references public.outbox_eventos(id) on delete set null,
    tentativas        integer not null default 0,
    ultimo_erro       text null,
    concluida_em      timestamptz null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint uq_titular_tarefa_sistema unique (solicitacao_id, sistema),
    constraint chk_fundamento_quando_retido check (
        status <> 'retained_with_reason' or (fundamento is not null and length(trim(fundamento)) > 0)
    )
);

create index if not exists idx_titular_tarefas_solicitacao
    on public.titular_solicitacao_tarefas(solicitacao_id);

create index if not exists idx_titular_tarefas_pendentes
    on public.titular_solicitacao_tarefas(status)
    where status in ('pending', 'retryable');

-- 4. Histórico append-only. Nunca copia o conjunto de dados exportado —
--    apenas ação/estado/reason/correlação.
create table if not exists public.titular_solicitacao_historico (
    id                uuid primary key default gen_random_uuid(),
    solicitacao_id    uuid not null references public.titular_solicitacoes(id) on delete cascade,
    evento_tipo       text not null,
    estado_anterior   text,
    estado_novo       text,
    reason_code       text,
    actor_id          uuid null,
    correlation_id    text,
    metadata          jsonb not null default '{}'::jsonb,
    created_at        timestamptz not null default now()
);

create index if not exists idx_titular_historico_solicitacao
    on public.titular_solicitacao_historico(solicitacao_id, created_at);

-- 5. Metadados de exportação: nunca a URL pública, nunca o conteúdo. Arquivo
--    físico cifrado vive fora do banco (disco temporário do processo); esta
--    linha só guarda o caminho, expiração e manifest.
create table if not exists public.titular_exportacoes (
    id                uuid primary key default gen_random_uuid(),
    solicitacao_id    uuid not null references public.titular_solicitacoes(id) on delete cascade,
    caminho_arquivo   text not null,
    manifest          jsonb not null,
    status            text not null default 'disponivel' check (status in ('disponivel', 'expirado', 'removido')),
    expira_em         timestamptz not null,
    created_at        timestamptz not null default now(),
    removido_em       timestamptz null
);

create index if not exists idx_titular_exportacoes_expiracao
    on public.titular_exportacoes(expira_em)
    where status = 'disponivel';

-- ============================================================================
-- RPC: registrar solicitação com idempotência (dedupe de pedido repetido)
-- ============================================================================
create or replace function public.registrar_solicitacao_titular(
    p_organizacao_id          uuid,
    p_titular_tipo            text,
    p_titular_ref_user_id     uuid,
    p_titular_ref_cliente_id  uuid,
    p_titular_contato_cifrado text,
    p_tipo_direito            text,
    p_canal                   text,
    p_sla_vencimento          timestamptz,
    p_idempotency_key         text,
    p_correlation_id          text,
    p_metadata                jsonb default '{}'::jsonb
)
returns table (
    solicitacao_id uuid,
    estado         text,
    versao         integer,
    is_duplicate   boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existing record;
    v_new_id uuid;
begin
    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'p_idempotency_key é obrigatório para registrar solicitação do titular';
    end if;

    -- Colunas qualificadas com o alias `t`: os parâmetros OUT desta função
    -- (`estado`, `versao`) têm o mesmo nome de colunas da tabela, o que
    -- causaria erro 42702 (referência de coluna ambígua) em PL/pgSQL se a
    -- consulta usasse nomes de coluna não qualificados.
    select t.id, t.estado, t.versao into v_existing
    from public.titular_solicitacoes t
    where t.organizacao_id = p_organizacao_id
      and t.idempotency_key = p_idempotency_key;

    if found then
        solicitacao_id := v_existing.id;
        estado := v_existing.estado;
        versao := v_existing.versao;
        is_duplicate := true;
        return next;
        return;
    end if;

    insert into public.titular_solicitacoes (
        organizacao_id, titular_tipo, titular_ref_user_id, titular_ref_cliente_id,
        titular_contato_cifrado, tipo_direito, canal, sla_vencimento,
        idempotency_key, correlation_id, metadata
    ) values (
        p_organizacao_id, p_titular_tipo, p_titular_ref_user_id, p_titular_ref_cliente_id,
        p_titular_contato_cifrado, p_tipo_direito, coalesce(p_canal, 'web'), p_sla_vencimento,
        p_idempotency_key, p_correlation_id, coalesce(p_metadata, '{}'::jsonb)
    )
    returning id into v_new_id;

    insert into public.titular_solicitacao_historico (
        solicitacao_id, evento_tipo, estado_anterior, estado_novo, correlation_id, metadata
    ) values (
        v_new_id, 'received', null, 'received', p_correlation_id, '{}'::jsonb
    );

    solicitacao_id := v_new_id;
    estado := 'received';
    versao := 0;
    is_duplicate := false;
    return next;
end;
$$;

-- ============================================================================
-- RPC: aplicar transição de estado com CAS (compare-and-swap) por versão,
-- mesmo padrão de alternar_organizacao_ativa_cas (migration 38). Nunca
-- regride estado; grava sempre uma linha de histórico (auditoria).
-- ============================================================================
create or replace function public.aplicar_transicao_solicitacao_titular(
    p_solicitacao_id   uuid,
    p_organizacao_id   uuid,
    p_versao_esperada  integer,
    p_novo_estado      text,
    p_reason_code      text,
    p_actor_id         uuid,
    p_correlation_id   text,
    p_metadata         jsonb default '{}'::jsonb
)
returns table (
    aplicado        boolean,
    estado_atual    text,
    versao_atual    integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row record;
begin
    select t.id, t.organizacao_id, t.estado, t.versao into v_row
    from public.titular_solicitacoes t
    where t.id = p_solicitacao_id
    for update;

    if not found or v_row.organizacao_id <> p_organizacao_id then
        aplicado := false;
        estado_atual := null;
        versao_atual := null;
        return next;
        return;
    end if;

    if v_row.versao <> p_versao_esperada then
        aplicado := false;
        estado_atual := v_row.estado;
        versao_atual := v_row.versao;
        return next;
        return;
    end if;

    update public.titular_solicitacoes
    set estado = p_novo_estado,
        versao = v_row.versao + 1,
        correlation_id = coalesce(p_correlation_id, correlation_id),
        updated_at = now()
    where id = p_solicitacao_id;

    insert into public.titular_solicitacao_historico (
        solicitacao_id, evento_tipo, estado_anterior, estado_novo, reason_code, actor_id, correlation_id, metadata
    ) values (
        p_solicitacao_id, p_novo_estado, v_row.estado, p_novo_estado, p_reason_code, p_actor_id, p_correlation_id,
        coalesce(p_metadata, '{}'::jsonb)
    );

    aplicado := true;
    estado_atual := p_novo_estado;
    versao_atual := v_row.versao + 1;
    return next;
end;
$$;

-- ============================================================================
-- RPC: upsert de tarefa por sistema (idempotente por solicitacao+sistema)
-- ============================================================================
create or replace function public.registrar_tarefa_solicitacao_titular(
    p_solicitacao_id   uuid,
    p_sistema          text,
    p_status           text,
    p_fundamento       text default null,
    p_outbox_evento_id uuid default null,
    p_ultimo_erro      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    insert into public.titular_solicitacao_tarefas (
        solicitacao_id, sistema, status, fundamento, outbox_evento_id, ultimo_erro,
        tentativas, concluida_em
    ) values (
        p_solicitacao_id, p_sistema, p_status, p_fundamento, p_outbox_evento_id, p_ultimo_erro,
        case when p_status in ('retryable', 'failed') then 1 else 0 end,
        case when p_status in ('completed', 'not_found', 'retained_with_reason') then now() else null end
    )
    on conflict (solicitacao_id, sistema) do update
    set status = excluded.status,
        fundamento = excluded.fundamento,
        outbox_evento_id = coalesce(excluded.outbox_evento_id, public.titular_solicitacao_tarefas.outbox_evento_id),
        ultimo_erro = excluded.ultimo_erro,
        tentativas = public.titular_solicitacao_tarefas.tentativas
            + case when excluded.status in ('retryable', 'failed') then 1 else 0 end,
        concluida_em = case
            when excluded.status in ('completed', 'not_found', 'retained_with_reason') then now()
            else public.titular_solicitacao_tarefas.concluida_em
        end,
        updated_at = now()
    returning id into v_id;

    return v_id;
end;
$$;

-- ============================================================================
-- Privilégios mínimos e RLS (OWASP ASVS L2)
-- ============================================================================
revoke all on public.titular_solicitacoes from public, anon;
revoke all on public.titular_solicitacao_verificacoes from public, anon;
revoke all on public.titular_solicitacao_tarefas from public, anon;
revoke all on public.titular_solicitacao_historico from public, anon;
revoke all on public.titular_exportacoes from public, anon;

grant select on public.titular_solicitacoes to authenticated;
grant select on public.titular_solicitacao_tarefas to authenticated;
grant select on public.titular_solicitacao_historico to authenticated;
grant select on public.titular_exportacoes to authenticated;
-- Verificações nunca são legíveis por authenticated (contêm hash de código); só service_role.
grant all on public.titular_solicitacoes to service_role;
grant all on public.titular_solicitacao_verificacoes to service_role;
grant all on public.titular_solicitacao_tarefas to service_role;
grant all on public.titular_solicitacao_historico to service_role;
grant all on public.titular_exportacoes to service_role;

revoke all on function public.registrar_solicitacao_titular(uuid, text, uuid, uuid, text, text, text, timestamptz, text, text, jsonb) from public, anon;
revoke all on function public.aplicar_transicao_solicitacao_titular(uuid, uuid, integer, text, text, uuid, text, jsonb) from public, anon;
revoke all on function public.registrar_tarefa_solicitacao_titular(uuid, text, text, text, uuid, text) from public, anon;

grant execute on function public.registrar_solicitacao_titular(uuid, text, uuid, uuid, text, text, text, timestamptz, text, text, jsonb) to service_role;
grant execute on function public.aplicar_transicao_solicitacao_titular(uuid, uuid, integer, text, text, uuid, text, jsonb) to service_role;
grant execute on function public.registrar_tarefa_solicitacao_titular(uuid, text, text, text, uuid, text) to service_role;

alter table public.titular_solicitacoes enable row level security;
alter table public.titular_solicitacao_verificacoes enable row level security;
alter table public.titular_solicitacao_tarefas enable row level security;
alter table public.titular_solicitacao_historico enable row level security;
alter table public.titular_exportacoes enable row level security;

drop policy if exists "Admins veem solicitacoes da propria organizacao" on public.titular_solicitacoes;
create policy "Admins veem solicitacoes da propria organizacao"
    on public.titular_solicitacoes
    for select
    to authenticated
    using (
        exists (
            select 1 from public.membros_organizacao m
            where m.organizacao_id = titular_solicitacoes.organizacao_id
              and m.user_id = auth.uid()
              and m.papel in ('owner', 'admin')
        )
    );

drop policy if exists "Admins veem tarefas da propria organizacao" on public.titular_solicitacao_tarefas;
create policy "Admins veem tarefas da propria organizacao"
    on public.titular_solicitacao_tarefas
    for select
    to authenticated
    using (
        exists (
            select 1 from public.titular_solicitacoes s
            join public.membros_organizacao m on m.organizacao_id = s.organizacao_id
            where s.id = titular_solicitacao_tarefas.solicitacao_id
              and m.user_id = auth.uid()
              and m.papel in ('owner', 'admin')
        )
    );

drop policy if exists "Admins veem historico da propria organizacao" on public.titular_solicitacao_historico;
create policy "Admins veem historico da propria organizacao"
    on public.titular_solicitacao_historico
    for select
    to authenticated
    using (
        exists (
            select 1 from public.titular_solicitacoes s
            join public.membros_organizacao m on m.organizacao_id = s.organizacao_id
            where s.id = titular_solicitacao_historico.solicitacao_id
              and m.user_id = auth.uid()
              and m.papel in ('owner', 'admin')
        )
    );

drop policy if exists "Admins veem exportacoes da propria organizacao" on public.titular_exportacoes;
create policy "Admins veem exportacoes da propria organizacao"
    on public.titular_exportacoes
    for select
    to authenticated
    using (
        exists (
            select 1 from public.titular_solicitacoes s
            join public.membros_organizacao m on m.organizacao_id = s.organizacao_id
            where s.id = titular_exportacoes.solicitacao_id
              and m.user_id = auth.uid()
              and m.papel in ('owner', 'admin')
        )
    );
