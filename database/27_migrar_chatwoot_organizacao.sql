-- ============================================================================
-- 27_migrar_chatwoot_organizacao.sql
-- Ticket 31: Migrar a conexão Chatwoot para organização
-- Multi-Tenancy Organizacional para Inboxes, Contatos, Conversas e Mensagens
-- ============================================================================

-- 0. Garantir existência das tabelas base do domínio Chatwoot
create table if not exists public.chatwoot_inboxes (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid references auth.users(id) on delete cascade,
    inbox_id         int not null,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table if not exists public.chatwoot_contacts (
    id               int primary key,
    user_id          uuid references auth.users(id) on delete cascade,
    name             text not null,
    email            text,
    phone_number     text,
    phone_normalizado text,
    avatar_url       text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table if not exists public.chatwoot_conversations (
    id               int primary key,
    user_id          uuid references auth.users(id) on delete cascade,
    display_id       int,
    contact_id       int not null references public.chatwoot_contacts(id) on delete cascade,
    status           text not null default 'open',
    inbox_id         int,
    channel          text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table if not exists public.chatwoot_messages (
    id               int primary key,
    user_id          uuid references auth.users(id) on delete cascade,
    conversation_id  int not null references public.chatwoot_conversations(id) on delete cascade,
    content          text,
    message_type     text,
    sender_name      text,
    sender_id        int,
    sender_type      text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

-- 1. Adicionar colunas organizacao_id e conexao_id nas tabelas do domínio Chatwoot
alter table public.chatwoot_inboxes
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade,
    add column if not exists conexao_id uuid references public.conexoes_integracao(id) on delete set null,
    alter column user_id drop not null;

alter table public.chatwoot_contacts
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade,
    add column if not exists conexao_id uuid references public.conexoes_integracao(id) on delete set null,
    alter column user_id drop not null;

alter table public.chatwoot_conversations
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade,
    add column if not exists conexao_id uuid references public.conexoes_integracao(id) on delete set null,
    alter column user_id drop not null;

alter table public.chatwoot_messages
    add column if not exists organizacao_id uuid references public.organizacoes(id) on delete cascade,
    add column if not exists conexao_id uuid references public.conexoes_integracao(id) on delete set null,
    alter column user_id drop not null;

-- 2. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
grant select on public.chatwoot_inboxes to authenticated;
grant select on public.chatwoot_contacts to authenticated;
grant select on public.chatwoot_conversations to authenticated;
grant select on public.chatwoot_messages to authenticated;

grant all on public.chatwoot_inboxes to service_role, postgres;
grant all on public.chatwoot_contacts to service_role, postgres;
grant all on public.chatwoot_conversations to service_role, postgres;
grant all on public.chatwoot_messages to service_role, postgres;

-- 3. Índices de Tenancy e Unicidade por Organização
alter table public.chatwoot_inboxes
    drop constraint if exists chatwoot_inboxes_inbox_id_key;

create index if not exists idx_chatwoot_inboxes_org on public.chatwoot_inboxes(organizacao_id);
create index if not exists idx_chatwoot_inboxes_conexao on public.chatwoot_inboxes(conexao_id);

create index if not exists idx_chatwoot_contacts_org on public.chatwoot_contacts(organizacao_id);
create index if not exists idx_chatwoot_contacts_conexao on public.chatwoot_contacts(conexao_id);

create index if not exists idx_chatwoot_conversations_org on public.chatwoot_conversations(organizacao_id);
create index if not exists idx_chatwoot_conversations_conexao on public.chatwoot_conversations(conexao_id);

create index if not exists idx_chatwoot_messages_org on public.chatwoot_messages(organizacao_id);
create index if not exists idx_chatwoot_messages_conexao on public.chatwoot_messages(conexao_id);

create unique index if not exists uq_chatwoot_inboxes_org_inbox
    on public.chatwoot_inboxes(organizacao_id, inbox_id)
    where organizacao_id is not null and inbox_id is not null;

create unique index if not exists uq_chatwoot_contacts_org_id
    on public.chatwoot_contacts(organizacao_id, id)
    where organizacao_id is not null and id is not null;

create unique index if not exists uq_chatwoot_conversations_org_id
    on public.chatwoot_conversations(organizacao_id, id)
    where organizacao_id is not null and id is not null;

create unique index if not exists uq_chatwoot_messages_org_id
    on public.chatwoot_messages(organizacao_id, id)
    where organizacao_id is not null and id is not null;

-- 4. Funções de Trigger para Auto-Preenchimento e Integridade Anti Cross-Tenant

-- 4.1 Inboxes Trigger Function
create or replace function public.fn_sync_chatwoot_inboxes_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_owner_user_id uuid;
begin
    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_sync_chatwoot_inboxes_organizacao on public.chatwoot_inboxes;
create trigger trg_sync_chatwoot_inboxes_organizacao
    before insert or update on public.chatwoot_inboxes
    for each row
    execute function public.fn_sync_chatwoot_inboxes_organizacao();

-- 4.2 Contacts Trigger Function
create or replace function public.fn_sync_chatwoot_contacts_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_owner_user_id uuid;
begin
    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_sync_chatwoot_contacts_organizacao on public.chatwoot_contacts;
create trigger trg_sync_chatwoot_contacts_organizacao
    before insert or update on public.chatwoot_contacts
    for each row
    execute function public.fn_sync_chatwoot_contacts_organizacao();

-- 4.3 Conversations Trigger Function
create or replace function public.fn_sync_chatwoot_conversations_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_contact_org_id uuid;
    v_owner_user_id uuid;
begin
    -- 1. Se organizacao_id não foi informada, herdar do contato
    if new.contact_id is not null then
        select organizacao_id into v_contact_org_id
        from public.chatwoot_contacts
        where id = new.contact_id;

        if new.organizacao_id is null and v_contact_org_id is not null then
            new.organizacao_id := v_contact_org_id;
        end if;

        -- Validação de integridade: a conversa não pode ter organização diferente do contato
        if new.organizacao_id is not null and v_contact_org_id is not null and new.organizacao_id <> v_contact_org_id then
            raise exception 'Cross-tenant violation: a conversa (org %) pertence a uma organizacao diferente do contato (org %)',
                new.organizacao_id, v_contact_org_id
                using errcode = '23503';
        end if;
    end if;

    -- 2. Fallback de resolução via user_id
    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    -- 3. Fallback de user_id via owner
    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_sync_chatwoot_conversations_organizacao on public.chatwoot_conversations;
create trigger trg_sync_chatwoot_conversations_organizacao
    before insert or update on public.chatwoot_conversations
    for each row
    execute function public.fn_sync_chatwoot_conversations_organizacao();

-- 4.4 Messages Trigger Function
create or replace function public.fn_sync_chatwoot_messages_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_id uuid;
    v_conv_org_id uuid;
    v_owner_user_id uuid;
begin
    -- 1. Se organizacao_id não foi informada, herdar da conversa
    if new.conversation_id is not null then
        select organizacao_id into v_conv_org_id
        from public.chatwoot_conversations
        where id = new.conversation_id;

        if new.organizacao_id is null and v_conv_org_id is not null then
            new.organizacao_id := v_conv_org_id;
        end if;

        -- Validação de integridade: a mensagem não pode ter organização diferente da conversa
        if new.organizacao_id is not null and v_conv_org_id is not null and new.organizacao_id <> v_conv_org_id then
            raise exception 'Cross-tenant violation: a mensagem (org %) pertence a uma organizacao diferente da conversa (org %)',
                new.organizacao_id, v_conv_org_id
                using errcode = '23503';
        end if;
    end if;

    -- 2. Fallback de resolução via user_id
    if new.organizacao_id is null and new.user_id is not null then
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = new.user_id
        order by (case when papel = 'owner' then 1 else 2 end), created_at asc
        limit 1;

        if v_org_id is not null then
            new.organizacao_id := v_org_id;
        end if;
    end if;

    -- 3. Fallback de user_id via owner
    if new.user_id is null and new.organizacao_id is not null then
        select user_id into v_owner_user_id
        from public.membros_organizacao
        where organizacao_id = new.organizacao_id
          and papel = 'owner'
        limit 1;

        if v_owner_user_id is not null then
            new.user_id := v_owner_user_id;
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_sync_chatwoot_messages_organizacao on public.chatwoot_messages;
create trigger trg_sync_chatwoot_messages_organizacao
    before insert or update on public.chatwoot_messages
    for each row
    execute function public.fn_sync_chatwoot_messages_organizacao();

-- 5. Atualização de Políticas RLS por Organização

drop policy if exists "Isolamento por tenant" on public.chatwoot_inboxes;
drop policy if exists "Isolamento por tenant" on public.chatwoot_contacts;
drop policy if exists "Isolamento por tenant" on public.chatwoot_conversations;
drop policy if exists "Isolamento por tenant" on public.chatwoot_messages;

drop policy if exists "Acesso a chatwoot_inboxes por organizacao" on public.chatwoot_inboxes;
drop policy if exists "Acesso a chatwoot_contacts por organizacao" on public.chatwoot_contacts;
drop policy if exists "Acesso a chatwoot_conversations por organizacao" on public.chatwoot_conversations;
drop policy if exists "Acesso a chatwoot_messages por organizacao" on public.chatwoot_messages;

create policy "Acesso a chatwoot_inboxes por organizacao"
    on public.chatwoot_inboxes
    for all
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));

create policy "Acesso a chatwoot_contacts por organizacao"
    on public.chatwoot_contacts
    for all
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));

create policy "Acesso a chatwoot_conversations por organizacao"
    on public.chatwoot_conversations
    for all
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));

create policy "Acesso a chatwoot_messages por organizacao"
    on public.chatwoot_messages
    for all
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));

-- 6. Função de Backfill para dados legados do Chatwoot
create or replace function public.migrar_chatwoot_para_organizacoes()
returns table (
    migrados_inboxes integer,
    migrados_contatos integer,
    migrados_conversas integer,
    migrados_mensagens integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_inboxes integer := 0;
    v_contatos integer := 0;
    v_conversas integer := 0;
    v_mensagens integer := 0;
begin
    -- 1. Inboxes
    update public.chatwoot_inboxes ci
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel in ('owner', 'admin') then 1 else 2 end), created_at asc
    ) m
    where ci.user_id = m.user_id
      and ci.organizacao_id is null;
    get diagnostics v_inboxes = row_count;

    -- 2. Contatos
    update public.chatwoot_contacts cc
    set organizacao_id = m.organizacao_id
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel in ('owner', 'admin') then 1 else 2 end), created_at asc
    ) m
    where cc.user_id = m.user_id
      and cc.organizacao_id is null;
    get diagnostics v_contatos = row_count;

    -- 3. Conversas
    update public.chatwoot_conversations cconv
    set organizacao_id = coalesce(
        (select organizacao_id from public.chatwoot_contacts cc where cc.id = cconv.contact_id),
        m.organizacao_id
    )
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel in ('owner', 'admin') then 1 else 2 end), created_at asc
    ) m
    where cconv.user_id = m.user_id
      and cconv.organizacao_id is null;
    get diagnostics v_conversas = row_count;

    -- 4. Mensagens
    update public.chatwoot_messages cm
    set organizacao_id = coalesce(
        (select organizacao_id from public.chatwoot_conversations cconv where cconv.id = cm.conversation_id),
        m.organizacao_id
    )
    from (
        select distinct on (user_id) user_id, organizacao_id
        from public.membros_organizacao
        order by user_id, (case when papel in ('owner', 'admin') then 1 else 2 end), created_at asc
    ) m
    where cm.user_id = m.user_id
      and cm.organizacao_id is null;
    get diagnostics v_mensagens = row_count;

    migrados_inboxes := v_inboxes;
    migrados_contatos := v_contatos;
    migrados_conversas := v_conversas;
    migrados_mensagens := v_mensagens;
    return next;
    return;
end;
$$;
