-- 77_contato_excluido_no_bling.sql
--
-- PRE-005: `contact.deleted` do Bling marca o contato como excluído; nunca o
-- apaga e nunca inventa um cadastro.
--
-- Antes desta migration o webhook tratava `contact.deleted` como atualização:
-- sem `nome` no payload mínimo, gravava `Cliente #<id>` por cima do nome real
-- (ou criava um contato com esse nome), e um `contact.updated` atrasado
-- recriava um contato que o Bling já tinha excluído.
--
-- 1. `clientes.excluido_no_bling_em`: o contato local continua (pedidos, casos
--    e solicitações LGPD apontam para ele), marcado como fora do Bling. Só os
--    comandos abaixo mudam esse campo.
-- 2. `contatos_excluidos_no_bling`: a exclusão por (organização, `bling_id`),
--    registrada mesmo quando o ORBITA nunca teve o contato. Só uma vigente por
--    par; a reativação explícita encerra a vigente e fica no registro.
-- 3. Nenhuma gravação cria, regrava pelo upsert ou passa a apontar para um
--    contato com exclusão vigente. A exclusão, a reativação e a gravação se
--    serializam numa trava consultiva do mesmo (organização, `bling_id`).
-- 4. `reativar_contato_excluido_no_bling`: o único caminho de volta, chamado
--    pela reconciliação explícita (quem administra a organização, com o
--    contato confirmado ativo no Bling). Nenhum evento reativa sozinho.
--
-- Forward-only. Rollback: quarentenar `contact.deleted` no webhook e
-- reprocessar depois; nunca redirecionar para o upsert.

alter table public.clientes add column if not exists excluido_no_bling_em timestamptz;

comment on column public.clientes.excluido_no_bling_em is
    'Quando o contato foi excluído no Bling (PRE-005). Não nulo: fora de venda nova e de sincronização até a reativação explícita.';

create table if not exists public.contatos_excluidos_no_bling (
    id                   uuid primary key default gen_random_uuid(),
    organizacao_id       uuid not null references public.organizacoes(id) on delete cascade,
    bling_id             text not null check (bling_id ~ '^[1-9][0-9]*$'),
    -- O contato local marcado pela exclusão, quando existia.
    cliente_id           uuid references public.clientes(id) on delete set null,
    -- A data do evento no Bling, quando veio; o registro local é `registrado_em`.
    excluido_no_bling_em timestamptz,
    registrado_em        timestamptz not null default now(),
    -- Reativação explícita: quando e por quem. Nula = exclusão vigente.
    reativado_em         timestamptz,
    reativado_por        uuid references auth.users(id) on delete set null,
    constraint chk_contato_reativado_por_tem_data check (reativado_por is null or reativado_em is not null)
);

comment on table public.contatos_excluidos_no_bling is
    'Exclusão de contato no Bling (PRE-005). Só insere e encerra por reativação explícita; um update atrasado não recria o contato.';

create unique index if not exists uq_contato_excluido_vigente
    on public.contatos_excluidos_no_bling (organizacao_id, bling_id)
    where reativado_em is null;

revoke all on public.contatos_excluidos_no_bling from public, anon, authenticated;
grant select, insert on public.contatos_excluidos_no_bling to service_role;
grant update (reativado_em, reativado_por) on public.contatos_excluidos_no_bling to service_role;
alter table public.contatos_excluidos_no_bling enable row level security;

-- ---------------------------------------------------------------------------
-- O registro de exclusão não se apaga nem se reescreve.
-- ---------------------------------------------------------------------------
create or replace function public.fn_exclusao_de_contato_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    -- A exclusão em cascata da organização segue (a linha dela já não existe).
    if tg_op = 'DELETE' and not exists (select 1 from public.organizacoes o where o.id = old.organizacao_id) then
        return old;
    end if;
    if tg_op = 'UPDATE' and new.id = old.id and new.organizacao_id = old.organizacao_id and new.bling_id = old.bling_id
       and new.excluido_no_bling_em is not distinct from old.excluido_no_bling_em
       and new.registrado_em = old.registrado_em then
        -- As FKs `on delete set null` só perdem o vínculo.
        if new.reativado_em is not distinct from old.reativado_em
           and (new.cliente_id is not distinct from old.cliente_id or new.cliente_id is null)
           and (new.reativado_por is not distinct from old.reativado_por or new.reativado_por is null) then
            return new;
        end if;
        -- A reativação: uma vez, com autor, só pelo comando (`reativar_contato_excluido_no_bling`).
        if old.reativado_em is null and new.reativado_em is not null and new.reativado_por is not null
           and new.cliente_id is not distinct from old.cliente_id
           and current_setting('orbita.reativacao_de_contato', true) = old.id::text then
            return new;
        end if;
    end if;
    raise exception 'A exclusao de um contato no Bling e registro permanente.' using errcode = '23514';
end;
$$;

revoke all on function public.fn_exclusao_de_contato_imutavel() from public, anon, authenticated;

drop trigger if exists tg_exclusao_de_contato_imutavel on public.contatos_excluidos_no_bling;
create trigger tg_exclusao_de_contato_imutavel
    before update or delete on public.contatos_excluidos_no_bling
    for each row execute function public.fn_exclusao_de_contato_imutavel();

-- A trava consultiva do (organização, `bling_id`) que exclusão, reativação e
-- gravação de contato compartilham.
create or replace function public.fn_travar_bling_id_de_contato(p_organizacao_id uuid, p_bling_id text)
returns void
language sql
set search_path = ''
as $$
    select pg_advisory_xact_lock(hashtextextended(p_organizacao_id::text || ':contato-bling:' || p_bling_id, 0));
$$;

revoke all on function public.fn_travar_bling_id_de_contato(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Nenhuma gravação traz de volta um contato excluído no Bling.
--
-- Vale para o INSERT (inclusive o `insert ... on conflict do update` do
-- webhook e da sincronização, cujo BEFORE INSERT roda antes da resolução do
-- conflito) e para o UPDATE que troca `bling_id` ou `organizacao_id`.
-- `excluido_no_bling_em` só muda pelos comandos desta migration.
-- ---------------------------------------------------------------------------
create or replace function public.fn_contato_excluido_no_bling_nao_volta()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if (tg_op = 'INSERT' and new.excluido_no_bling_em is not null)
       or (tg_op = 'UPDATE' and new.excluido_no_bling_em is distinct from old.excluido_no_bling_em) then
        if current_setting('orbita.ciclo_do_contato', true) is distinct from new.id::text then
            raise exception 'A exclusao do contato no Bling so muda pela reconciliacao.' using errcode = '23514';
        end if;
        return new;
    end if;
    if new.bling_id is null or new.bling_id !~ '^[1-9][0-9]*$' then
        return new;
    end if;
    if tg_op = 'UPDATE' and new.bling_id = old.bling_id and new.organizacao_id = old.organizacao_id then
        return new;
    end if;
    perform public.fn_travar_bling_id_de_contato(new.organizacao_id, new.bling_id);
    if exists (select 1 from public.contatos_excluidos_no_bling e
                where e.organizacao_id = new.organizacao_id and e.bling_id = new.bling_id and e.reativado_em is null) then
        raise exception 'Contato % foi excluido no Bling; so volta pela reconciliacao.', new.bling_id using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_contato_excluido_no_bling_nao_volta() from public, anon, authenticated;

drop trigger if exists tg_contato_excluido_no_bling_nao_volta on public.clientes;
create trigger tg_contato_excluido_no_bling_nao_volta
    before insert or update of bling_id, organizacao_id, excluido_no_bling_em on public.clientes
    for each row execute function public.fn_contato_excluido_no_bling_nao_volta();

-- ---------------------------------------------------------------------------
-- O comando do webhook.
--
-- desfecho: `registrado` (tinha o contato, agora marcado), `registrado_sem_contato`
-- (o ORBITA nunca o teve; a exclusão impede que ele apareça depois) ou
-- `ja_registrado` (reentrega: nada muda).
-- ---------------------------------------------------------------------------
create or replace function public.registrar_exclusao_de_contato_no_bling(
    p_organizacao_id uuid,
    p_bling_id text,
    p_excluido_no_bling_em timestamptz default null
)
returns table (desfecho text, cliente_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_cliente_id uuid;
    v_existente uuid;
begin
    if p_organizacao_id is null or p_bling_id is null or p_bling_id !~ '^[1-9][0-9]*$' then
        raise exception 'Organizacao e id numerico do Bling sao obrigatorios.' using errcode = '22023';
    end if;

    perform public.fn_travar_bling_id_de_contato(p_organizacao_id, p_bling_id);

    select e.cliente_id into v_existente
      from public.contatos_excluidos_no_bling e
     where e.organizacao_id = p_organizacao_id and e.bling_id = p_bling_id and e.reativado_em is null;
    if found then
        return query select 'ja_registrado'::text, v_existente;
        return;
    end if;

    select c.id into v_cliente_id
      from public.clientes c
     where c.organizacao_id = p_organizacao_id and c.bling_id = p_bling_id
       for update;

    insert into public.contatos_excluidos_no_bling (organizacao_id, bling_id, cliente_id, excluido_no_bling_em)
    values (p_organizacao_id, p_bling_id, v_cliente_id, p_excluido_no_bling_em);

    if v_cliente_id is null then
        return query select 'registrado_sem_contato'::text, null::uuid;
        return;
    end if;

    perform set_config('orbita.ciclo_do_contato', v_cliente_id::text, true);
    update public.clientes c
       set excluido_no_bling_em = coalesce(p_excluido_no_bling_em, now())
     where c.id = v_cliente_id;
    perform set_config('orbita.ciclo_do_contato', '', true);

    return query select 'registrado'::text, v_cliente_id;
end;
$$;

revoke all on function public.registrar_exclusao_de_contato_no_bling(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.registrar_exclusao_de_contato_no_bling(uuid, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- A reativação explícita, chamada pela reconciliação depois de confirmar o
-- contato ativo no Bling. O ator precisa administrar a organização.
--
-- desfecho: `reativado` ou `nao_excluido` (não havia exclusão vigente).
-- ---------------------------------------------------------------------------
create or replace function public.reativar_contato_excluido_no_bling(
    p_organizacao_id uuid,
    p_bling_id text,
    p_ator_id uuid
)
returns table (desfecho text, cliente_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_exclusao_id uuid;
    v_cliente_id uuid;
begin
    if p_organizacao_id is null or p_ator_id is null or p_bling_id is null or p_bling_id !~ '^[1-9][0-9]*$' then
        raise exception 'Organizacao, ator e id numerico do Bling sao obrigatorios.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.membros_organizacao m
                    where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id and m.papel in ('owner', 'admin')) then
        raise exception 'Somente quem administra a organizacao reativa um contato.' using errcode = '42501';
    end if;

    perform public.fn_travar_bling_id_de_contato(p_organizacao_id, p_bling_id);

    select e.id into v_exclusao_id
      from public.contatos_excluidos_no_bling e
     where e.organizacao_id = p_organizacao_id and e.bling_id = p_bling_id and e.reativado_em is null
       for update;
    if not found then
        return query select 'nao_excluido'::text, null::uuid;
        return;
    end if;

    perform set_config('orbita.reativacao_de_contato', v_exclusao_id::text, true);
    update public.contatos_excluidos_no_bling e
       set reativado_em = now(), reativado_por = p_ator_id
     where e.id = v_exclusao_id;
    perform set_config('orbita.reativacao_de_contato', '', true);

    select c.id into v_cliente_id
      from public.clientes c
     where c.organizacao_id = p_organizacao_id and c.bling_id = p_bling_id
       for update;
    if v_cliente_id is not null then
        perform set_config('orbita.ciclo_do_contato', v_cliente_id::text, true);
        update public.clientes c set excluido_no_bling_em = null where c.id = v_cliente_id;
        perform set_config('orbita.ciclo_do_contato', '', true);
    end if;

    return query select 'reativado'::text, v_cliente_id;
end;
$$;

revoke all on function public.reativar_contato_excluido_no_bling(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reativar_contato_excluido_no_bling(uuid, text, uuid) to service_role;
