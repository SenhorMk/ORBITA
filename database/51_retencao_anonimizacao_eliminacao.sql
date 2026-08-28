-- ============================================================================
-- 51_retencao_anonimizacao_eliminacao.sql
-- Ticket 18: Implementar retenção, anonimização e eliminação
--
-- Mecanismo completo de ciclo de vida de dados. Os PRAZOS não estão
-- aprovados ainda (Ticket 15 — docs/privacy/ropa.md / data-inventory.md
-- seguem `needs-legal-review`/`needs-owner`). Este arquivo cria o
-- mecanismo/engine, não a política real: todas as linhas de seed do
-- registry ficam `status = 'pending_approval'` com `prazo_dias` claramente
-- placeholder. Nenhuma execução real (`execute`) deve rodar em produção
-- antes de uma migration futura reaprovada trocar `status` para `approved`
-- com prazos reais — ver `docs/adr/ticket-18-retencao-anonimizacao-eliminacao.md`.
--
-- Forward-only: só cria tabelas/colunas/índices novos, nunca altera
-- comportamento de tabela existente além de duas colunas aditivas
-- (`clientes.anonimizado_em`, dois índices compostos de leitura).
--
--   1. retention_policy_registry  - registry machine-readable versionado
--   2. retention_legal_holds      - impedimento por entidade, por categoria
--   3. retention_runs             - execução (dry_run|execute) idempotente
--   4. retention_run_items        - item processado dentro de uma run
--   5. retention_tombstones       - ledger protegido (append-only)
--
-- Autoridade: toda escrita passa por RPC security definer chamada apenas
-- pela camada de aplicação (service_role); RLS restringe leitura de
-- metadados (nunca dado pessoal bruto) a owner/admin da própria organização.
-- ============================================================================

-- ============================================================================
-- 1. Registry de política — versionado, nunca mutado in-place
-- ============================================================================
create table if not exists public.retention_policy_registry (
    id                    uuid primary key default gen_random_uuid(),
    categoria             text not null,
    versao                integer not null,
    tabela_alvo           text not null check (tabela_alvo in ('clientes', 'chatwoot_contacts')),
    coluna_relogio        text not null check (coluna_relogio in ('created_at', 'updated_at')),
    prazo_dias            integer not null check (prazo_dias > 0),
    acao                  text not null check (acao in ('retain', 'anonymize', 'delete')),
    legal_hold_padrao     boolean not null default false,
    requer_validacao_obrigacao boolean not null default false,
    owner                 text not null,
    status                text not null default 'pending_approval'
                              check (status in ('pending_approval', 'approved', 'disabled')),
    notas                 text,
    created_at            timestamptz not null default now(),
    constraint uq_retention_policy_categoria_versao unique (categoria, versao)
);

comment on table public.retention_policy_registry is
    'Ticket 18: registry versionado de política de retenção. Linhas nunca são '
    'atualizadas (UPDATE) — uma mudança de prazo/ação cria uma nova versão. '
    'Todas as categorias reais seguem status=pending_approval até aprovação '
    'jurídica/produto explícita (Ticket 15). Ver needs-owner no ADR do ticket 18.';

-- Só pode existir uma versão "approved" por categoria por vez.
create unique index if not exists uq_retention_policy_categoria_aprovada
    on public.retention_policy_registry(categoria)
    where status = 'approved';

create index if not exists idx_retention_policy_categoria
    on public.retention_policy_registry(categoria, versao desc);

-- Seed: mecanismo pronto, prazos NÃO aprovados. `prazo_dias` é um placeholder
-- óbvio (não um número que pareça decisão real de produto) — o valor exato é
-- só um detalhe de teste enquanto o relógio for injetado; a ativação real
-- exige uma migration futura reaprovada. Ver Ticket 15 (`data-inventory.md`
-- linha 11, `cpf_cnpj`/e-mail/telefone de `clientes`) e linha 18
-- (`chatwoot_contacts`, "Indefinida — sem TTL").
insert into public.retention_policy_registry (
    categoria, versao, tabela_alvo, coluna_relogio, prazo_dias, acao,
    legal_hold_padrao, requer_validacao_obrigacao, owner, status, notas
) values (
    'cliente_final_pii', 1, 'clientes', 'updated_at', 999999, 'anonymize',
    false, true, 'needs-owner:dpo',
    'pending_approval',
    'PLACEHOLDER NÃO APROVADO. Prazo real pendente de revisão jurídica '
    '(Ticket 15, data-inventory.md #11). `requer_validacao_obrigacao=true` '
    'porque `clientes` tem FK RESTRICT de `pedidos` (trigger '
    'tg_prevenir_exclusao_cliente) — nunca elegível para `delete`, só '
    '`anonymize` preserva integridade referencial.'
),
(
    'chatwoot_contato_inativo', 1, 'chatwoot_contacts', 'updated_at', 999999, 'delete',
    false, false, 'needs-owner:dpo',
    'pending_approval',
    'PLACEHOLDER NÃO APROVADO. Nenhuma obrigação fiscal/legal identificada '
    'para contato de atendimento (Ticket 15, data-inventory.md #18) — mas o '
    'prazo real ainda depende de revisão de produto/suporte antes de '
    'aprovação. `delete` cascade remove conversas/mensagens vinculadas '
    '(FK ON DELETE CASCADE já existente em chatwoot_conversations).'
)
on conflict (categoria, versao) do nothing;

-- ============================================================================
-- 2. Legal hold por entidade — sempre vence, mesmo com cutoff vencido
-- ============================================================================
create table if not exists public.retention_legal_holds (
    id                uuid primary key default gen_random_uuid(),
    organizacao_id    uuid not null references public.organizacoes(id) on delete cascade,
    categoria         text not null,
    entidade_id       text not null,
    motivo            text not null check (length(trim(motivo)) > 0),
    criado_por        uuid null,
    criado_em         timestamptz not null default now(),
    liberado_em       timestamptz null
);

-- Só pode existir um hold ATIVO por (organização, categoria, entidade).
create unique index if not exists uq_retention_hold_ativo
    on public.retention_legal_holds(organizacao_id, categoria, entidade_id)
    where liberado_em is null;

create index if not exists idx_retention_holds_lookup
    on public.retention_legal_holds(organizacao_id, categoria, entidade_id)
    where liberado_em is null;

-- ============================================================================
-- 3. Runs — dry-run/execução, idempotente por chave determinística
-- ============================================================================
create table if not exists public.retention_runs (
    id                      uuid primary key default gen_random_uuid(),
    organizacao_id          uuid not null references public.organizacoes(id) on delete cascade,
    categoria               text not null,
    policy_versao           integer not null,
    modo                    text not null check (modo in ('dry_run', 'execute')),
    cutoff                  timestamptz not null,
    status                  text not null default 'running'
                                check (status in ('running', 'completed', 'completed_with_errors', 'failed')),
    contagem_selecionados   integer not null default 0,
    contagem_processados    integer not null default 0,
    contagem_falhos         integer not null default 0,
    contagem_hold           integer not null default 0,
    erro_redigido           text null,
    correlation_id          text,
    iniciado_em             timestamptz not null default now(),
    concluido_em            timestamptz null,
    constraint uq_retention_run_idempotente
        unique (organizacao_id, categoria, policy_versao, modo, cutoff)
);

create index if not exists idx_retention_runs_org_status
    on public.retention_runs(organizacao_id, status);

-- ============================================================================
-- 4. Itens de uma run — claim idempotente via unique constraint
-- ============================================================================
create table if not exists public.retention_run_items (
    id                uuid primary key default gen_random_uuid(),
    run_id            uuid not null references public.retention_runs(id) on delete cascade,
    entidade_id       text not null,
    status            text not null default 'selected' check (status in (
                          'selected', 'done', 'skipped_legal_hold', 'skipped_already_processed',
                          'skipped_before_cutoff', 'skipped_policy_not_approved',
                          'skipped_dry_run_previewed', 'failed'
                      )),
    erro_redigido     text null,
    tentativas        integer not null default 0,
    processed_at      timestamptz null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint uq_retention_run_item unique (run_id, entidade_id)
);

create index if not exists idx_retention_run_items_run
    on public.retention_run_items(run_id, status);

drop trigger if exists tg_retention_run_items_updated_at on public.retention_run_items;
create trigger tg_retention_run_items_updated_at
    before update on public.retention_run_items
    for each row execute function public.fn_set_updated_at();

-- ============================================================================
-- 5. Tombstones — ledger protegido, append-only, imutável mesmo p/ service_role
-- ============================================================================
create table if not exists public.retention_tombstones (
    id                uuid primary key default gen_random_uuid(),
    organizacao_id    uuid not null references public.organizacoes(id) on delete cascade,
    categoria         text not null,
    entidade_id       text not null,
    acao              text not null check (acao in ('anonymized', 'deleted')),
    run_id            uuid not null references public.retention_runs(id) on delete restrict,
    efetivado_em      timestamptz not null default now(),
    constraint uq_retention_tombstone unique (organizacao_id, categoria, entidade_id)
);

create index if not exists idx_retention_tombstones_org
    on public.retention_tombstones(organizacao_id, categoria);

comment on table public.retention_tombstones is
    'Ticket 18: ledger protegido — nunca UPDATE/DELETE, nem por service_role '
    '(tg_retention_tombstones_bloquear_mutacao). Usado para detectar, após um '
    'restore de backup, dado que já havia sido eliminado e reaplicar a '
    'supressão antes de servir tráfego (retencao_reaplicar_tombstones_restore).';

create or replace function public.fn_retention_tombstone_bloquear_mutacao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    raise exception
        'retention_tombstones é um ledger append-only protegido — % não é permitido (id=%).',
        tg_op, coalesce(old.id, new.id)
        using errcode = '0LTMB';
end;
$$;

drop trigger if exists tg_retention_tombstones_bloquear_update on public.retention_tombstones;
create trigger tg_retention_tombstones_bloquear_update
    before update on public.retention_tombstones
    for each row execute function public.fn_retention_tombstone_bloquear_mutacao();

drop trigger if exists tg_retention_tombstones_bloquear_delete on public.retention_tombstones;
create trigger tg_retention_tombstones_bloquear_delete
    before delete on public.retention_tombstones
    for each row execute function public.fn_retention_tombstone_bloquear_mutacao();

-- ============================================================================
-- 6. Colunas/índices aditivos nas tabelas alvo (marcador de idempotência +
--    índice usado pela query de seleção compartilhada)
-- ============================================================================
alter table public.clientes
    add column if not exists anonimizado_em timestamptz null;

create index if not exists idx_clientes_org_updated_retencao
    on public.clientes(organizacao_id, updated_at)
    where anonimizado_em is null;

create index if not exists idx_chatwoot_contacts_org_updated_retencao
    on public.chatwoot_contacts(organizacao_id, updated_at);

-- ============================================================================
-- 7. RPC: iniciar (ou recuperar) uma run — idempotente por unique constraint.
--    Duas chamadas concorrentes com os MESMOS parâmetros sempre convergem no
--    mesmo runId (nunca duplicam a run).
-- ============================================================================
create or replace function public.retencao_iniciar_run(
    p_organizacao_id  uuid,
    p_categoria       text,
    p_policy_versao   integer,
    p_modo            text,
    p_cutoff          timestamptz,
    p_correlation_id  text default null
)
returns table (run_id uuid, ja_existia boolean, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
    v_status text;
begin
    if p_modo not in ('dry_run', 'execute') then
        raise exception 'p_modo inválido: %', p_modo using errcode = '22023';
    end if;

    insert into public.retention_runs (
        organizacao_id, categoria, policy_versao, modo, cutoff, correlation_id
    ) values (
        p_organizacao_id, p_categoria, p_policy_versao, p_modo, p_cutoff, p_correlation_id
    )
    on conflict (organizacao_id, categoria, policy_versao, modo, cutoff) do nothing
    returning id, retention_runs.status into v_id, v_status;

    if found then
        run_id := v_id;
        ja_existia := false;
        status := v_status;
        return next;
        return;
    end if;

    select r.id, r.status into v_id, v_status
    from public.retention_runs r
    where r.organizacao_id = p_organizacao_id
      and r.categoria = p_categoria
      and r.policy_versao = p_policy_versao
      and r.modo = p_modo
      and r.cutoff = p_cutoff;

    run_id := v_id;
    ja_existia := true;
    status := v_status;
    return next;
end;
$$;

-- ============================================================================
-- 8. RPC: seletor compartilhado — dry-run e execução chamam EXATAMENTE esta
--    função (só o adapter de efeito muda depois). Usa índice
--    (organizacao_id, coluna_relogio) e reivindica (claim) o item via
--    `insert ... on conflict do nothing returning` — concorrência nunca
--    processa o mesmo item duas vezes dentro da mesma run.
-- ============================================================================
-- Implementação interna: os nomes de OUT param NÃO podem colidir com o nome
-- de coluna `entidade_id` (existente em `retention_run_items`/`retention_legal_holds`)
-- — colidir causa "column reference is ambiguous" (PostgreSQL 42702) em
-- qualquer uso não qualificado dentro do corpo da função, incluindo a lista
-- de colunas de `ON CONFLICT (...)`, que não aceita qualificação por tabela.
-- Por isso esta função interna usa nomes `out_*` e é exposta ao chamador
-- através do wrapper público logo abaixo, que restaura os nomes de coluna
-- estáveis (`entidade_id`, `relogio`, ...) usados por testes e TypeScript.
create or replace function public.retencao_selecionar_e_reivindicar_lote_impl(
    p_run_id          uuid,
    p_organizacao_id  uuid,
    p_categoria       text,
    p_tabela_alvo     text,
    p_cutoff          timestamptz,
    p_limit           integer default 100
)
returns table (
    out_entidade_id     text,
    out_relogio         timestamptz,
    out_em_legal_hold   boolean,
    out_ja_processado   boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_limit is null or p_limit <= 0 or p_limit > 1000 then
        raise exception 'p_limit deve estar entre 1 e 1000 (recebido %)', p_limit using errcode = '22023';
    end if;

    if p_tabela_alvo = 'clientes' then
        return query
        with candidatos as (
            select
                c.id::text as v_entidade_id,
                c.updated_at as v_relogio,
                (c.anonimizado_em is not null) as v_ja_processado
            from public.clientes c
            where c.organizacao_id = p_organizacao_id
              and c.updated_at <= p_cutoff
            order by c.updated_at asc
            limit p_limit
            for update of c skip locked
        ),
        reivindicados as (
            insert into public.retention_run_items as rri (run_id, entidade_id, status)
            select p_run_id, cand.v_entidade_id, 'selected'
            from candidatos cand
            on conflict (run_id, entidade_id) do nothing
            returning rri.entidade_id as v_reivindicado_id
        )
        select
            cand.v_entidade_id,
            cand.v_relogio,
            (h.id is not null) as em_legal_hold,
            cand.v_ja_processado
        from candidatos cand
        join reivindicados r on r.v_reivindicado_id = cand.v_entidade_id
        left join public.retention_legal_holds h
            on h.organizacao_id = p_organizacao_id
           and h.categoria = p_categoria
           and h.entidade_id = cand.v_entidade_id
           and h.liberado_em is null;
        return;
    elsif p_tabela_alvo = 'chatwoot_contacts' then
        return query
        with candidatos as (
            select
                cc.id::text as v_entidade_id,
                cc.updated_at as v_relogio,
                false as v_ja_processado
            from public.chatwoot_contacts cc
            where cc.organizacao_id = p_organizacao_id
              and cc.updated_at <= p_cutoff
            order by cc.updated_at asc
            limit p_limit
            for update of cc skip locked
        ),
        reivindicados as (
            insert into public.retention_run_items as rri (run_id, entidade_id, status)
            select p_run_id, cand.v_entidade_id, 'selected'
            from candidatos cand
            on conflict (run_id, entidade_id) do nothing
            returning rri.entidade_id as v_reivindicado_id
        )
        select
            cand.v_entidade_id,
            cand.v_relogio,
            (h.id is not null) as em_legal_hold,
            cand.v_ja_processado
        from candidatos cand
        join reivindicados r on r.v_reivindicado_id = cand.v_entidade_id
        left join public.retention_legal_holds h
            on h.organizacao_id = p_organizacao_id
           and h.categoria = p_categoria
           and h.entidade_id = cand.v_entidade_id
           and h.liberado_em is null;
        return;
    else
        raise exception 'tabela_alvo não suportada pelo seletor de retenção: %', p_tabela_alvo
            using errcode = '22023';
    end if;
end;
$$;

-- Wrapper público: nomes de coluna estáveis (`entidade_id`, `relogio`,
-- `em_legal_hold`, `ja_processado`) — o mesmo nome usado pelos testes pgTAP e
-- por `src/services/privacy/retentionRunService.ts`. `language sql` não tem
-- variáveis PL/pgSQL, então não há risco de colisão aqui.
create or replace function public.retencao_selecionar_e_reivindicar_lote(
    p_run_id          uuid,
    p_organizacao_id  uuid,
    p_categoria       text,
    p_tabela_alvo     text,
    p_cutoff          timestamptz,
    p_limit           integer default 100
)
returns table (
    entidade_id     text,
    relogio         timestamptz,
    em_legal_hold   boolean,
    ja_processado   boolean
)
language sql
security definer
set search_path = public
as $$
    select out_entidade_id, out_relogio, out_em_legal_hold, out_ja_processado
    from public.retencao_selecionar_e_reivindicar_lote_impl(
        p_run_id, p_organizacao_id, p_categoria, p_tabela_alvo, p_cutoff, p_limit
    );
$$;

-- ============================================================================
-- 9. RPC: registrar o resultado final de um item + manter contadores da run
-- ============================================================================
create or replace function public.retencao_registrar_item(
    p_run_id       uuid,
    p_entidade_id  text,
    p_status       text,
    p_erro         text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.retention_run_items
    set status = p_status,
        erro_redigido = p_erro,
        tentativas = tentativas + case when p_status = 'failed' then 1 else 0 end,
        processed_at = case when p_status in ('done', 'failed') then now() else processed_at end,
        updated_at = now()
    where run_id = p_run_id and entidade_id = p_entidade_id;

    update public.retention_runs
    set contagem_selecionados = contagem_selecionados + 1,
        contagem_processados = contagem_processados + case when p_status = 'done' then 1 else 0 end,
        contagem_falhos = contagem_falhos + case when p_status = 'failed' then 1 else 0 end,
        contagem_hold = contagem_hold + case when p_status = 'skipped_legal_hold' then 1 else 0 end
    where id = p_run_id;
end;
$$;

-- ============================================================================
-- 10. RPC: anonimizar uma única entidade (bounded — sempre 1 id + organização
--     explícita, nunca um UPDATE sem chave). Irreversível: nunca hash, só
--     null direto — proibido pelo ticket manter chave de reidentificação.
-- ============================================================================
create or replace function public.retencao_aplicar_anonimizacao(
    p_run_id          uuid,
    p_organizacao_id  uuid,
    p_categoria       text,
    p_tabela_alvo     text,
    p_entidade_id     text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hold_ativo boolean;
    v_linhas int;
begin
    select exists (
        select 1 from public.retention_legal_holds h
        where h.organizacao_id = p_organizacao_id
          and h.categoria = p_categoria
          and h.entidade_id = p_entidade_id
          and h.liberado_em is null
    ) into v_hold_ativo;

    if v_hold_ativo then
        return false;
    end if;

    if p_tabela_alvo = 'clientes' then
        update public.clientes
        set nome = 'Titular anonimizado',
            cpf_cnpj = null,
            email = null,
            telefone = null,
            telefone_normalizado = null,
            anonimizado_em = now(),
            updated_at = now()
        where id = p_entidade_id::uuid
          and organizacao_id = p_organizacao_id
          and anonimizado_em is null;
        get diagnostics v_linhas = row_count;
    else
        raise exception 'tabela_alvo não suportada pela anonimização de retenção: %', p_tabela_alvo
            using errcode = '22023';
    end if;

    if v_linhas = 0 then
        -- Já anonimizado ou não pertence a esta organização — idempotente,
        -- não é erro, mas também não gera tombstone duplicado.
        return true;
    end if;

    insert into public.retention_tombstones (organizacao_id, categoria, entidade_id, acao, run_id)
    values (p_organizacao_id, p_categoria, p_entidade_id, 'anonymized', p_run_id)
    on conflict (organizacao_id, categoria, entidade_id) do nothing;

    return true;
end;
$$;

-- ============================================================================
-- 11. RPC: eliminar uma única entidade (bounded, verifica legal hold).
--     Nunca chamada para `clientes` (sem tabela_alvo suportada além de
--     chatwoot_contacts — clientes tem FK RESTRICT de pedidos e nunca é
--     elegível a delete pelo registry).
-- ============================================================================
create or replace function public.retencao_aplicar_exclusao(
    p_run_id          uuid,
    p_organizacao_id  uuid,
    p_categoria       text,
    p_tabela_alvo     text,
    p_entidade_id     text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hold_ativo boolean;
    v_linhas int;
begin
    select exists (
        select 1 from public.retention_legal_holds h
        where h.organizacao_id = p_organizacao_id
          and h.categoria = p_categoria
          and h.entidade_id = p_entidade_id
          and h.liberado_em is null
    ) into v_hold_ativo;

    if v_hold_ativo then
        return false;
    end if;

    if p_tabela_alvo = 'chatwoot_contacts' then
        delete from public.chatwoot_contacts
        where id = p_entidade_id::int
          and organizacao_id = p_organizacao_id;
        get diagnostics v_linhas = row_count;
    else
        raise exception 'tabela_alvo não suportada pela exclusão de retenção: %', p_tabela_alvo
            using errcode = '22023';
    end if;

    if v_linhas = 0 then
        -- Já eliminado (idempotente) ou não pertence a esta organização.
        insert into public.retention_tombstones (organizacao_id, categoria, entidade_id, acao, run_id)
        values (p_organizacao_id, p_categoria, p_entidade_id, 'deleted', p_run_id)
        on conflict (organizacao_id, categoria, entidade_id) do nothing;
        return true;
    end if;

    insert into public.retention_tombstones (organizacao_id, categoria, entidade_id, acao, run_id)
    values (p_organizacao_id, p_categoria, p_entidade_id, 'deleted', p_run_id)
    on conflict (organizacao_id, categoria, entidade_id) do nothing;

    return true;
end;
$$;

-- ============================================================================
-- 12. RPC: concluir a run. Falha parcial NUNCA vira 'completed' — a própria
--     RPC recusa esse status se `contagem_falhos > 0`.
-- ============================================================================
create or replace function public.retencao_concluir_run(
    p_run_id uuid,
    p_status text,
    p_erro_redigido text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_falhos int;
    v_status_final text;
begin
    select contagem_falhos into v_falhos from public.retention_runs where id = p_run_id;
    if not found then
        raise exception 'retention_run % não encontrada', p_run_id using errcode = 'P0002';
    end if;

    if p_status = 'completed' and v_falhos > 0 then
        v_status_final := 'completed_with_errors';
    else
        v_status_final := p_status;
    end if;

    if v_status_final not in ('completed', 'completed_with_errors', 'failed') then
        raise exception 'status final inválido: %', v_status_final using errcode = '22023';
    end if;

    update public.retention_runs
    set status = v_status_final,
        erro_redigido = p_erro_redigido,
        concluido_em = now()
    where id = p_run_id;
end;
$$;

-- ============================================================================
-- 13. RPC: legal hold — marcar/liberar
-- ============================================================================
create or replace function public.retencao_marcar_legal_hold(
    p_organizacao_id uuid,
    p_categoria      text,
    p_entidade_id    text,
    p_motivo         text,
    p_criado_por     uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    insert into public.retention_legal_holds (organizacao_id, categoria, entidade_id, motivo, criado_por)
    values (p_organizacao_id, p_categoria, p_entidade_id, p_motivo, p_criado_por)
    returning id into v_id;
    return v_id;
end;
$$;

create or replace function public.retencao_liberar_legal_hold(
    p_organizacao_id uuid,
    p_categoria      text,
    p_entidade_id    text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_linhas int;
begin
    update public.retention_legal_holds
    set liberado_em = now()
    where organizacao_id = p_organizacao_id
      and categoria = p_categoria
      and entidade_id = p_entidade_id
      and liberado_em is null;
    get diagnostics v_linhas = row_count;
    return v_linhas > 0;
end;
$$;

-- ============================================================================
-- 14. RPC: reconciliação pós-restore de backup. Um restore de backup pode
--     reintroduzir uma linha que já havia sido anonimizada/eliminada antes
--     do backup ter sido tirado. Esta função varre o ledger de tombstones da
--     organização e reaplica a supressão em qualquer linha que "voltou" —
--     deve ser chamada ANTES de servir tráfego após um restore.
-- ============================================================================
create or replace function public.retencao_reaplicar_tombstones_restore(
    p_organizacao_id uuid
)
returns table (
    entidade_id      text,
    categoria        text,
    acao             text,
    reaplicado       boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tomb record;
    v_ainda_existe boolean;
    v_policy record;
begin
    for v_tomb in
        select t.entidade_id, t.categoria, t.acao
        from public.retention_tombstones t
        where t.organizacao_id = p_organizacao_id
    loop
        select r.tabela_alvo into v_policy
        from public.retention_policy_registry r
        where r.categoria = v_tomb.categoria
        order by r.versao desc
        limit 1;

        if v_policy.tabela_alvo = 'clientes' then
            select exists (
                select 1 from public.clientes c
                where c.id = v_tomb.entidade_id::uuid
                  and c.organizacao_id = p_organizacao_id
                  and c.anonimizado_em is null
            ) into v_ainda_existe;

            if v_ainda_existe then
                update public.clientes
                set nome = 'Titular anonimizado',
                    cpf_cnpj = null,
                    email = null,
                    telefone = null,
                    telefone_normalizado = null,
                    anonimizado_em = now(),
                    updated_at = now()
                where id = v_tomb.entidade_id::uuid
                  and organizacao_id = p_organizacao_id;
            end if;
        elsif v_policy.tabela_alvo = 'chatwoot_contacts' then
            select exists (
                select 1 from public.chatwoot_contacts cc
                where cc.id = v_tomb.entidade_id::int
                  and cc.organizacao_id = p_organizacao_id
            ) into v_ainda_existe;

            if v_ainda_existe then
                delete from public.chatwoot_contacts
                where id = v_tomb.entidade_id::int
                  and organizacao_id = p_organizacao_id;
            end if;
        else
            v_ainda_existe := false;
        end if;

        entidade_id := v_tomb.entidade_id;
        categoria := v_tomb.categoria;
        acao := v_tomb.acao;
        reaplicado := coalesce(v_ainda_existe, false);
        return next;
    end loop;
end;
$$;

-- ============================================================================
-- 15. Privilégios mínimos e RLS (OWASP ASVS L2)
-- ============================================================================
revoke all on public.retention_policy_registry from public, anon;
revoke all on public.retention_legal_holds from public, anon;
revoke all on public.retention_runs from public, anon;
revoke all on public.retention_run_items from public, anon;
revoke all on public.retention_tombstones from public, anon;

grant select on public.retention_policy_registry to authenticated;
grant select on public.retention_runs to authenticated;
grant select on public.retention_run_items to authenticated;
-- Legal holds e tombstones nunca são legíveis por `authenticated` diretamente
-- (podem revelar identidade/motivo de investigação) — só service_role.
grant all on public.retention_policy_registry to service_role;
grant all on public.retention_legal_holds to service_role;
grant all on public.retention_runs to service_role;
grant all on public.retention_run_items to service_role;
grant all on public.retention_tombstones to service_role;

revoke all on function public.retencao_iniciar_run(uuid, text, integer, text, timestamptz, text) from public, anon;
revoke all on function public.retencao_selecionar_e_reivindicar_lote_impl(uuid, uuid, text, text, timestamptz, integer) from public, anon;
revoke all on function public.retencao_selecionar_e_reivindicar_lote(uuid, uuid, text, text, timestamptz, integer) from public, anon;
revoke all on function public.retencao_registrar_item(uuid, text, text, text) from public, anon;
revoke all on function public.retencao_aplicar_anonimizacao(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.retencao_aplicar_exclusao(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.retencao_concluir_run(uuid, text, text) from public, anon;
revoke all on function public.retencao_marcar_legal_hold(uuid, text, text, text, uuid) from public, anon;
revoke all on function public.retencao_liberar_legal_hold(uuid, text, text) from public, anon;
revoke all on function public.retencao_reaplicar_tombstones_restore(uuid) from public, anon;

grant execute on function public.retencao_iniciar_run(uuid, text, integer, text, timestamptz, text) to service_role;
grant execute on function public.retencao_selecionar_e_reivindicar_lote_impl(uuid, uuid, text, text, timestamptz, integer) to service_role;
grant execute on function public.retencao_selecionar_e_reivindicar_lote(uuid, uuid, text, text, timestamptz, integer) to service_role;
grant execute on function public.retencao_registrar_item(uuid, text, text, text) to service_role;
grant execute on function public.retencao_aplicar_anonimizacao(uuid, uuid, text, text, text) to service_role;
grant execute on function public.retencao_aplicar_exclusao(uuid, uuid, text, text, text) to service_role;
grant execute on function public.retencao_concluir_run(uuid, text, text) to service_role;
grant execute on function public.retencao_marcar_legal_hold(uuid, text, text, text, uuid) to service_role;
grant execute on function public.retencao_liberar_legal_hold(uuid, text, text) to service_role;
grant execute on function public.retencao_reaplicar_tombstones_restore(uuid) to service_role;

alter table public.retention_policy_registry enable row level security;
alter table public.retention_legal_holds enable row level security;
alter table public.retention_runs enable row level security;
alter table public.retention_run_items enable row level security;
alter table public.retention_tombstones enable row level security;

drop policy if exists "Autenticados leem o registry de retencao" on public.retention_policy_registry;
create policy "Autenticados leem o registry de retencao"
    on public.retention_policy_registry
    for select
    to authenticated
    using (true);

drop policy if exists "Admins veem runs de retencao da propria organizacao" on public.retention_runs;
create policy "Admins veem runs de retencao da propria organizacao"
    on public.retention_runs
    for select
    to authenticated
    using (
        exists (
            select 1 from public.membros_organizacao m
            where m.organizacao_id = retention_runs.organizacao_id
              and m.user_id = auth.uid()
              and m.papel in ('owner', 'admin')
        )
    );

drop policy if exists "Admins veem itens de runs da propria organizacao" on public.retention_run_items;
create policy "Admins veem itens de runs da propria organizacao"
    on public.retention_run_items
    for select
    to authenticated
    using (
        exists (
            select 1 from public.retention_runs r
            join public.membros_organizacao m on m.organizacao_id = r.organizacao_id
            where r.id = retention_run_items.run_id
              and m.user_id = auth.uid()
              and m.papel in ('owner', 'admin')
        )
    );
