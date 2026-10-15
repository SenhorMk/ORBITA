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
--    e solicitações LGPD apontam para ele), marcado como fora do Bling.
--    `clientes.exclusao_pendente_desde`: uma exclusão recebida cuja ordem não
--    pôde ser provada (ver 5); fora de venda nova até a conferência. Só os
--    comandos abaixo mudam esses dois campos.
-- 2. `contatos_excluidos_no_bling`: a exclusão por (organização, `bling_id`),
--    registrada mesmo quando o ORBITA nunca teve o contato. Uma aberta por par
--    — confirmada ou pendente de conferência; encerrar (reativar) guarda quem
--    e quando, e o registro fica. `chave_do_evento` impede que a mesma entrega
--    tenha um segundo efeito depois de resolvida.
-- 3. Nenhuma gravação cria, regrava pelo upsert ou passa a apontar para um
--    contato com exclusão aberta. Exclusão, conferência, reativação e gravação
--    se serializam numa trava consultiva do mesmo (organização, `bling_id`).
-- 4. `reativar_contato_excluido_no_bling` e
--    `confirmar_exclusao_pendente_de_contato`: os únicos caminhos de saída,
--    chamados pela reconciliação explícita (quem administra a organização,
--    depois de ler o contato no Bling). Nenhum evento reativa sozinho.
-- 5. Uma exclusão que chega depois de uma reativação só vale se a data do
--    evento no Bling (`date`, autenticada pela assinatura) for claramente
--    posterior à reativação. Claramente anterior: é a exclusão antiga
--    reentregue com outra chave, e não desfaz a reativação. Sem data, ou
--    dentro da margem dos relógios: a ordem não é provável; o contato fica
--    **pendente de conferência** (bloqueado para venda nova, sem marca de
--    excluído) até a reconciliação ler o Bling. O Bling não garante ordem de
--    entrega; a data do evento é o único sinal de ordem do contrato.
--
-- Forward-only. Rollback: quarentenar `contact.deleted` no webhook e
-- reprocessar depois; nunca redirecionar para o upsert.

alter table public.clientes add column if not exists excluido_no_bling_em timestamptz;
alter table public.clientes add column if not exists exclusao_pendente_desde timestamptz;

comment on column public.clientes.excluido_no_bling_em is
    'Quando o contato foi excluído no Bling (PRE-005). Não nulo: fora de venda nova e de sincronização até a reativação explícita.';
comment on column public.clientes.exclusao_pendente_desde is
    'Exclusão recebida sem ordem provável depois de uma reativação (PRE-005). Não nulo: fora de venda nova até a conferência no Bling.';

create table if not exists public.contatos_excluidos_no_bling (
    id                   uuid primary key default gen_random_uuid(),
    organizacao_id       uuid not null references public.organizacoes(id) on delete cascade,
    bling_id             text not null check (bling_id ~ '^[1-9][0-9]*$'),
    -- O contato local marcado pela exclusão, quando existia.
    cliente_id           uuid references public.clientes(id) on delete set null,
    -- A data do evento no Bling, quando veio; o registro local é `registrado_em`.
    excluido_no_bling_em timestamptz,
    registrado_em        timestamptz not null default now(),
    -- Falso: recebida, mas a ordem não foi provada; aguarda a conferência no Bling.
    confirmada           boolean not null default true,
    -- A chave de idempotência da entrega que abriu este registro.
    chave_do_evento      text,
    -- Encerramento explícito (reativação): quando e por quem. Nulo = aberta.
    reativado_em         timestamptz,
    reativado_por        uuid references auth.users(id) on delete set null,
    constraint chk_contato_reativado_por_tem_data check (reativado_por is null or reativado_em is not null)
);

comment on table public.contatos_excluidos_no_bling is
    'Exclusão de contato no Bling (PRE-005). Só insere, confirma e encerra por comando explícito; um update atrasado não recria o contato.';

create unique index if not exists uq_contato_excluido_vigente
    on public.contatos_excluidos_no_bling (organizacao_id, bling_id)
    where reativado_em is null;
create index if not exists idx_contato_excluido_chave
    on public.contatos_excluidos_no_bling (organizacao_id, bling_id, chave_do_evento)
    where chave_do_evento is not null;

revoke all on public.contatos_excluidos_no_bling from public, anon, authenticated;
grant select, insert on public.contatos_excluidos_no_bling to service_role;
grant update (reativado_em, reativado_por, confirmada) on public.contatos_excluidos_no_bling to service_role;
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
       and new.registrado_em = old.registrado_em
       and new.chave_do_evento is not distinct from old.chave_do_evento then
        -- As FKs `on delete set null` só perdem o vínculo.
        if new.reativado_em is not distinct from old.reativado_em and new.confirmada = old.confirmada
           and (new.cliente_id is not distinct from old.cliente_id or new.cliente_id is null)
           and (new.reativado_por is not distinct from old.reativado_por or new.reativado_por is null) then
            return new;
        end if;
        -- O encerramento: uma vez, com autor, só pelo comando (`reativar_contato_excluido_no_bling`).
        if old.reativado_em is null and new.reativado_em is not null and new.reativado_por is not null
           and new.confirmada = old.confirmada and new.cliente_id is not distinct from old.cliente_id
           and current_setting('orbita.reativacao_de_contato', true) = old.id::text then
            return new;
        end if;
        -- A confirmação de uma pendente aberta, só pelo comando (`confirmar_exclusao_pendente_de_contato`
        -- ou a exclusão comprovadamente posterior).
        if old.reativado_em is null and new.reativado_em is null and new.reativado_por is not distinct from old.reativado_por
           and not old.confirmada and new.confirmada and new.cliente_id is not distinct from old.cliente_id
           and current_setting('orbita.confirmacao_de_exclusao', true) = old.id::text then
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

-- A trava consultiva do (organização, `bling_id`) que exclusão, conferência,
-- reativação e gravação de contato compartilham.
create or replace function public.fn_travar_bling_id_de_contato(p_organizacao_id uuid, p_bling_id text)
returns void
language sql
set search_path = ''
as $$
    select pg_advisory_xact_lock(hashtextextended(p_organizacao_id::text || ':contato-bling:' || p_bling_id, 0));
$$;

revoke all on function public.fn_travar_bling_id_de_contato(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Nenhuma gravação traz de volta um contato com exclusão aberta.
--
-- Vale para o INSERT (inclusive o `insert ... on conflict do update` do
-- webhook e da sincronização, cujo BEFORE INSERT roda antes da resolução do
-- conflito) e para o UPDATE que troca `bling_id` ou `organizacao_id`.
-- `excluido_no_bling_em` e `exclusao_pendente_desde` só mudam pelos comandos
-- desta migration.
-- ---------------------------------------------------------------------------
create or replace function public.fn_contato_excluido_no_bling_nao_volta()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if (tg_op = 'INSERT' and (new.excluido_no_bling_em is not null or new.exclusao_pendente_desde is not null))
       or (tg_op = 'UPDATE' and (new.excluido_no_bling_em is distinct from old.excluido_no_bling_em
                                 or new.exclusao_pendente_desde is distinct from old.exclusao_pendente_desde)) then
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
        raise exception 'Contato % tem exclusao aberta no Bling; so volta pela reconciliacao.', new.bling_id using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_contato_excluido_no_bling_nao_volta() from public, anon, authenticated;

drop trigger if exists tg_contato_excluido_no_bling_nao_volta on public.clientes;
create trigger tg_contato_excluido_no_bling_nao_volta
    before insert or update of bling_id, organizacao_id, excluido_no_bling_em, exclusao_pendente_desde on public.clientes
    for each row execute function public.fn_contato_excluido_no_bling_nao_volta();

-- Marca o contato local pelo comando (o gatilho acima só aceita sob esta GUC).
create or replace function public.fn_marcar_contato_no_ciclo(p_cliente_id uuid, p_excluido_em timestamptz, p_pendente_desde timestamptz)
returns void
language plpgsql
set search_path = ''
as $$
begin
    perform set_config('orbita.ciclo_do_contato', p_cliente_id::text, true);
    update public.clientes c
       set excluido_no_bling_em = p_excluido_em, exclusao_pendente_desde = p_pendente_desde
     where c.id = p_cliente_id;
    perform set_config('orbita.ciclo_do_contato', '', true);
end;
$$;

revoke all on function public.fn_marcar_contato_no_ciclo(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Só quem administra a organização encerra ou confirma uma exclusão.
create or replace function public.fn_exigir_administrador_da_organizacao(p_organizacao_id uuid, p_ator_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
    if not exists (select 1 from public.membros_organizacao m
                    where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id and m.papel in ('owner', 'admin')) then
        raise exception 'Somente quem administra a organizacao reconcilia um contato.' using errcode = '42501';
    end if;
end;
$$;

revoke all on function public.fn_exigir_administrador_da_organizacao(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- O comando do webhook.
--
-- desfecho:
-- - `registrado`: exclusão confirmada (o contato local, se havia, marcado);
-- - `registrado_sem_contato`: confirmada; o ORBITA nunca teve o contato;
-- - `ja_registrado`: já havia exclusão confirmada aberta, ou é a mesma entrega;
-- - `ja_resolvido`: a mesma entrega de um registro já encerrado; nada muda;
-- - `anterior_a_reativacao`: exclusão antiga, de antes da última reativação;
--   nada muda;
-- - `reconciliacao_necessaria`: depois de uma reativação, sem data que prove a
--   ordem; abre a pendência e bloqueia o contato para venda nova;
-- - `reconciliacao_pendente`: já havia pendência aberta e esta entrega também
--   não prova a ordem; nada muda.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_exclusao_de_contato_no_bling(
    p_organizacao_id uuid,
    p_bling_id text,
    p_excluido_no_bling_em timestamptz default null,
    p_chave_do_evento text default null
)
returns table (desfecho text, cliente_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_cliente_id uuid;
    v_aberta_id uuid;
    v_aberta_confirmada boolean;
    v_aberta_cliente uuid;
    v_mesma_entrega_aberta boolean;
    v_ultima_reativacao timestamptz;
    v_posterior boolean;
    -- Margem para a diferença entre o relógio do Bling e o do banco.
    c_margem constant interval := interval '5 minutes';
begin
    if p_organizacao_id is null or p_bling_id is null or p_bling_id !~ '^[1-9][0-9]*$' then
        raise exception 'Organizacao e id numerico do Bling sao obrigatorios.' using errcode = '22023';
    end if;

    perform public.fn_travar_bling_id_de_contato(p_organizacao_id, p_bling_id);

    -- A mesma entrega não tem segundo efeito, nem depois de resolvida.
    if p_chave_do_evento is not null then
        select e.reativado_em is null into v_mesma_entrega_aberta
          from public.contatos_excluidos_no_bling e
         where e.organizacao_id = p_organizacao_id and e.bling_id = p_bling_id and e.chave_do_evento = p_chave_do_evento
         order by e.registrado_em desc
         limit 1;
        if found then
            return query select (case when v_mesma_entrega_aberta then 'ja_registrado' else 'ja_resolvido' end)::text, null::uuid;
            return;
        end if;
    end if;

    select max(e.reativado_em) into v_ultima_reativacao
      from public.contatos_excluidos_no_bling e
     where e.organizacao_id = p_organizacao_id and e.bling_id = p_bling_id;
    v_posterior := v_ultima_reativacao is null
                   or (p_excluido_no_bling_em is not null and p_excluido_no_bling_em > v_ultima_reativacao + c_margem);

    select e.id, e.confirmada, e.cliente_id into v_aberta_id, v_aberta_confirmada, v_aberta_cliente
      from public.contatos_excluidos_no_bling e
     where e.organizacao_id = p_organizacao_id and e.bling_id = p_bling_id and e.reativado_em is null
       for update;
    if found then
        if v_aberta_confirmada then
            return query select 'ja_registrado'::text, v_aberta_cliente;
            return;
        end if;
        -- Pendente: só uma exclusão comprovadamente posterior a confirma.
        if not v_posterior then
            return query select 'reconciliacao_pendente'::text, v_aberta_cliente;
            return;
        end if;
        perform set_config('orbita.confirmacao_de_exclusao', v_aberta_id::text, true);
        update public.contatos_excluidos_no_bling e set confirmada = true where e.id = v_aberta_id;
        perform set_config('orbita.confirmacao_de_exclusao', '', true);
        if v_aberta_cliente is not null then
            perform public.fn_marcar_contato_no_ciclo(v_aberta_cliente, coalesce(p_excluido_no_bling_em, now()), null);
        end if;
        return query select 'registrado'::text, v_aberta_cliente;
        return;
    end if;

    if not v_posterior and p_excluido_no_bling_em is not null and p_excluido_no_bling_em < v_ultima_reativacao - c_margem then
        return query select 'anterior_a_reativacao'::text, null::uuid;
        return;
    end if;

    select c.id into v_cliente_id
      from public.clientes c
     where c.organizacao_id = p_organizacao_id and c.bling_id = p_bling_id
       for update;

    insert into public.contatos_excluidos_no_bling (organizacao_id, bling_id, cliente_id, excluido_no_bling_em, confirmada, chave_do_evento)
    values (p_organizacao_id, p_bling_id, v_cliente_id, p_excluido_no_bling_em, v_posterior, p_chave_do_evento);

    if not v_posterior then
        if v_cliente_id is not null then
            perform public.fn_marcar_contato_no_ciclo(v_cliente_id, null, now());
        end if;
        return query select 'reconciliacao_necessaria'::text, v_cliente_id;
        return;
    end if;

    if v_cliente_id is null then
        return query select 'registrado_sem_contato'::text, null::uuid;
        return;
    end if;

    perform public.fn_marcar_contato_no_ciclo(v_cliente_id, coalesce(p_excluido_no_bling_em, now()), null);
    return query select 'registrado'::text, v_cliente_id;
end;
$$;

revoke all on function public.registrar_exclusao_de_contato_no_bling(uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.registrar_exclusao_de_contato_no_bling(uuid, text, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- A reativação explícita, chamada pela reconciliação depois de ler o contato
-- ativo no Bling. Encerra a exclusão aberta — confirmada ou pendente — e
-- libera o contato local.
--
-- desfecho: `reativado` ou `nao_excluido` (não havia exclusão aberta).
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
    perform public.fn_exigir_administrador_da_organizacao(p_organizacao_id, p_ator_id);

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
        perform public.fn_marcar_contato_no_ciclo(v_cliente_id, null, null);
    end if;

    return query select 'reativado'::text, v_cliente_id;
end;
$$;

revoke all on function public.reativar_contato_excluido_no_bling(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reativar_contato_excluido_no_bling(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- A confirmação explícita de uma pendência, chamada pela reconciliação depois
-- de ler o contato excluído (`E`) ou ausente (404) no Bling. A pendência vira
-- exclusão confirmada; o contato fica marcado como excluído.
--
-- desfecho: `confirmada` ou `sem_pendencia` (nada aberto como pendente).
-- ---------------------------------------------------------------------------
create or replace function public.confirmar_exclusao_pendente_de_contato(
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
    perform public.fn_exigir_administrador_da_organizacao(p_organizacao_id, p_ator_id);

    perform public.fn_travar_bling_id_de_contato(p_organizacao_id, p_bling_id);

    select e.id into v_exclusao_id
      from public.contatos_excluidos_no_bling e
     where e.organizacao_id = p_organizacao_id and e.bling_id = p_bling_id and e.reativado_em is null and not e.confirmada
       for update;
    if not found then
        return query select 'sem_pendencia'::text, null::uuid;
        return;
    end if;

    perform set_config('orbita.confirmacao_de_exclusao', v_exclusao_id::text, true);
    update public.contatos_excluidos_no_bling e set confirmada = true where e.id = v_exclusao_id;
    perform set_config('orbita.confirmacao_de_exclusao', '', true);

    select c.id into v_cliente_id
      from public.clientes c
     where c.organizacao_id = p_organizacao_id and c.bling_id = p_bling_id
       for update;
    if v_cliente_id is not null then
        perform public.fn_marcar_contato_no_ciclo(v_cliente_id, now(), null);
    end if;

    return query select 'confirmada'::text, v_cliente_id;
end;
$$;

revoke all on function public.confirmar_exclusao_pendente_de_contato(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.confirmar_exclusao_pendente_de_contato(uuid, text, uuid) to service_role;
