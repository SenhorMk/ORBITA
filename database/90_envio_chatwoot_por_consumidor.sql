-- 90_envio_chatwoot_por_consumidor.sql
-- Forward-only. MSG-008: enviar no cockpit registra uma intenção; um worker
-- separado despacha ao Chatwoot.
--
-- ESTADO ANTERIOR (cadeia 01-89 e código de `ca56766`):
--   - `POST /api/chatwoot/send` monta a chave da outbox com `Date.now()`: um
--     clique duplo, um reload ou a repetição do POST criam outra intenção e
--     outro envio.
--   - O POST ao Chatwoot sai dentro da requisição HTTP, e o espelho local é
--     gravado depois do efeito, numa chamada separada: uma queda entre os dois
--     deixa a mensagem entregue sem registro local.
--   - Nada liga o envio à conversa, ao autor e ao comando que o pediu.
--
-- O QUE MUDA:
--   1. `chatwoot_envios`: a intenção (organização, conexão, conversa local,
--      `command_id` do navegador, digest do conteúdo, autor e evento da
--      outbox). Única por organização + `command_id`. Imutável, exceto o
--      vínculo com a mensagem espelhada, gravado uma vez.
--   2. `chatwoot_messages.envio_id`: proveniência da mensagem que nós enviamos.
--   3. `registrar_envio_chatwoot`: intenção + evento da outbox + auditoria numa
--      transação. A organização e o autor vêm da sessão; conexão e conversa, da
--      linha local. Mesmo comando e mesmo conteúdo devolvem a mesma intenção;
--      mesmo comando com outro conteúdo devolve `conflito`, sem gravar nada.
--   4. `reivindicar_envios_chatwoot`: o claim do worker. Só pega eventos que
--      têm intenção registrada aqui e foram criados depois do corte informado:
--      o backlog do envio inline (sem intenção) nunca é reivindicado.
--   5. `concluir_envio_chatwoot`: o desfecho pela conclusão por fencing da
--      MSG-007 e, quando há recibo, a mensagem espelhada com proveniência, na
--      mesma transação.
--
-- O QUE NÃO MUDA: a máquina de estados da outbox, o reaper e as funções da
-- MSG-007; o consumo da inbox (MSG-006). Nenhuma linha existente muda.
--
-- RECUPERAÇÃO: forward-only. Ver docs/operations/msg-008-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Intenção de envio.
-- ---------------------------------------------------------------------------
create table if not exists public.chatwoot_envios (
    id                 uuid primary key default gen_random_uuid(),
    organizacao_id     uuid not null references public.organizacoes(id) on delete cascade,
    conexao_id         uuid not null references public.conexoes_integracao(id) on delete cascade,
    conversa_id_local  uuid not null,
    command_id         uuid not null,
    payload_digest     text not null,
    conteudo           text not null,
    -- Quem pediu. Sem autor (pessoa removida), o worker recusa o despacho.
    ator_id            uuid references auth.users(id) on delete set null,
    outbox_evento_id   uuid not null,
    mensagem_id_local  uuid,
    created_at         timestamptz not null default now(),
    constraint ck_chatwoot_envios_digest check (payload_digest ~ '^[0-9a-f]{64}$'),
    constraint ck_chatwoot_envios_conteudo check (char_length(conteudo) between 1 and 4096),
    constraint uq_chatwoot_envios_org_comando unique (organizacao_id, command_id),
    constraint uq_chatwoot_envios_evento unique (outbox_evento_id),
    constraint uq_chatwoot_envios_org_id unique (organizacao_id, id),
    constraint fk_chatwoot_envios_conversa foreign key (organizacao_id, conversa_id_local)
        references public.chatwoot_conversations(organizacao_id, id_local) on delete cascade,
    constraint fk_chatwoot_envios_evento foreign key (organizacao_id, outbox_evento_id)
        references public.outbox_eventos(organizacao_id, id) on delete cascade,
    constraint fk_chatwoot_envios_mensagem foreign key (organizacao_id, mensagem_id_local)
        references public.chatwoot_messages(organizacao_id, id_local) on delete set null (mensagem_id_local)
);

create index if not exists idx_chatwoot_envios_conversa
    on public.chatwoot_envios (organizacao_id, conversa_id_local, created_at desc);

alter table public.chatwoot_envios enable row level security;
revoke all on public.chatwoot_envios from public, anon, authenticated;
-- Só leitura no servidor; escrita só pelas funções abaixo.
revoke all on public.chatwoot_envios from service_role;
grant select on public.chatwoot_envios to service_role;

create or replace function public.fn_chatwoot_envio_imutavel()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if new.id is distinct from old.id
       or new.organizacao_id is distinct from old.organizacao_id
       or new.conexao_id is distinct from old.conexao_id
       or new.conversa_id_local is distinct from old.conversa_id_local
       or new.command_id is distinct from old.command_id
       or new.payload_digest is distinct from old.payload_digest
       or new.conteudo is distinct from old.conteudo
       or new.outbox_evento_id is distinct from old.outbox_evento_id
       or new.created_at is distinct from old.created_at
       or (new.ator_id is distinct from old.ator_id and new.ator_id is not null) then
        raise exception 'MSG-008: a intencao de envio e imutavel.' using errcode = '23514';
    end if;
    if old.mensagem_id_local is not null and new.mensagem_id_local is distinct from old.mensagem_id_local
       and new.mensagem_id_local is not null then
        raise exception 'MSG-008: o vinculo do envio com a mensagem nao muda.' using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_chatwoot_envio_imutavel() from public, anon, authenticated;

drop trigger if exists tg_chatwoot_envios_imutavel on public.chatwoot_envios;
create trigger tg_chatwoot_envios_imutavel
    before update on public.chatwoot_envios
    for each row execute function public.fn_chatwoot_envio_imutavel();

-- ---------------------------------------------------------------------------
-- 2. Proveniência no espelho.
-- ---------------------------------------------------------------------------
alter table public.chatwoot_messages add column if not exists envio_id uuid;

alter table public.chatwoot_messages drop constraint if exists fk_chatwoot_messages_envio;
alter table public.chatwoot_messages
    add constraint fk_chatwoot_messages_envio foreign key (organizacao_id, envio_id)
        references public.chatwoot_envios(organizacao_id, id) on delete set null (envio_id);

create unique index if not exists uq_chatwoot_messages_envio
    on public.chatwoot_messages (envio_id)
    where envio_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Trilha: sem conteúdo, sem destinatário.
-- ---------------------------------------------------------------------------
create or replace function public.auditar_envio_chatwoot(
    p_organizacao_id uuid,
    p_ator_id        uuid,
    p_acao           text,
    p_envio_id       uuid,
    p_metadata       jsonb
)
returns void
language sql
security invoker
set search_path = ''
as $$
    insert into public.eventos_auditoria_sistema (organizacao_id, actor_id, acao, recurso, recurso_id, correlation_id, metadata)
    values (p_organizacao_id, p_ator_id, p_acao, 'chatwoot_envio', p_envio_id::text, null,
            -- Sem pessoa, o evento é do worker, como no consumo da inbox.
            case when p_ator_id is null then p_metadata || '{"_source": "worker"}'::jsonb else p_metadata end);
$$;

-- Projeção SQL de `auditEventCatalog.ts`.
insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('chatwoot.send_requested', 1, 'integrations', 'info', 'user', 1825, null,
     'Resposta registrada no cockpit para envio pelo worker.'),
    ('chatwoot.send_confirmed', 1, 'integrations', 'info', 'system', 1825, null,
     'Resposta confirmada pelo recibo do Chatwoot.'),
    ('chatwoot.send_rejected', 1, 'integrations', 'warning', 'system', 1825, null,
     'Resposta recusada de forma definitiva; não será repetida.')
on conflict (nome) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Registro da intenção.
--
-- Resultados: `registrado`, `existente` (mesmo comando, mesmo conteúdo),
-- `conflito` (mesmo comando, outro conteúdo), `sem_vinculo`,
-- `conversa_inexistente`, `conexao_indisponivel`. Só `registrado` grava.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_envio_chatwoot(
    p_organizacao_id    uuid,
    p_ator_id           uuid,
    p_conversa_id_local uuid,
    p_command_id        uuid,
    p_conteudo          text
)
returns table (resultado text, envio_id uuid, evento_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_conversa  record;
    v_conexao   record;
    v_digest    text;
    v_existente record;
    v_evento    uuid;
    v_envio     uuid;
begin
    if p_organizacao_id is null or p_ator_id is null or p_conversa_id_local is null or p_command_id is null
       or p_conteudo is null or p_conteudo <> btrim(p_conteudo) or char_length(p_conteudo) not between 1 and 4096 then
        raise exception 'MSG-008: comando de envio invalido.' using errcode = '22023';
    end if;

    if not exists (select 1 from public.membros_organizacao m
                    where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id) then
        return query select 'sem_vinculo'::text, null::uuid, null::uuid, null::text;
        return;
    end if;

    select c.id_local, c.conexao_id into v_conversa
      from public.chatwoot_conversations c
     where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local;
    if not found then
        return query select 'conversa_inexistente'::text, null::uuid, null::uuid, null::text;
        return;
    end if;

    -- O digest cobre a conversa e o texto: o mesmo comando em outra conversa
    -- também é conflito.
    v_digest := encode(pg_catalog.sha256(convert_to(p_conversa_id_local::text || chr(10) || p_conteudo, 'UTF8')), 'hex');

    -- Dois pedidos simultâneos do mesmo comando entram em fila aqui.
    perform pg_advisory_xact_lock(hashtextextended('chatwoot_envio:' || p_organizacao_id::text || ':' || p_command_id::text, 0));

    select e.id, e.payload_digest, e.outbox_evento_id, o.status as status_evento into v_existente
      from public.chatwoot_envios e
      join public.outbox_eventos o on o.organizacao_id = e.organizacao_id and o.id = e.outbox_evento_id
     where e.organizacao_id = p_organizacao_id and e.command_id = p_command_id;
    if found then
        return query select (case when v_existente.payload_digest = v_digest then 'existente' else 'conflito' end)::text,
                            v_existente.id, v_existente.outbox_evento_id, v_existente.status_evento::text;
        return;
    end if;

    select i.id, i.status into v_conexao
      from public.conexoes_integracao i
     where i.id = v_conversa.conexao_id and i.organizacao_id = p_organizacao_id and i.provedor = 'chatwoot';
    if not found or v_conexao.status = 'desconectado' then
        return query select 'conexao_indisponivel'::text, null::uuid, null::uuid, null::text;
        return;
    end if;

    -- Sem o texto no payload da outbox: ele fica na intenção, que o worker lê.
    select r.evento_id into v_evento
      from public.registrar_evento_outbox(
          p_organizacao_id, v_conversa.conexao_id, p_ator_id,
          'chatwoot.message.send:' || p_command_id::text, 'chatwoot', 'message.send',
          jsonb_build_object('command_id', p_command_id, 'conversa_id_local', p_conversa_id_local,
                             'conexao_id', v_conversa.conexao_id, 'payload_digest', v_digest),
          5) r
     where not r.is_duplicate;
    if v_evento is null then
        raise exception 'MSG-008: chave da outbox ja usada fora de um envio registrado.' using errcode = '23505';
    end if;

    insert into public.chatwoot_envios (organizacao_id, conexao_id, conversa_id_local, command_id, payload_digest,
                                        conteudo, ator_id, outbox_evento_id)
    values (p_organizacao_id, v_conversa.conexao_id, p_conversa_id_local, p_command_id, v_digest,
            p_conteudo, p_ator_id, v_evento)
    returning id into v_envio;

    perform public.auditar_envio_chatwoot(p_organizacao_id, p_ator_id, 'chatwoot.send_requested', v_envio,
        jsonb_build_object('conexao_id', v_conversa.conexao_id, 'evento_id', v_evento));

    return query select 'registrado'::text, v_envio, v_evento, 'pending'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Claim do worker: só envios registrados aqui, criados desde o corte.
-- ---------------------------------------------------------------------------
create or replace function public.reivindicar_envios_chatwoot(
    p_worker_id      text,
    p_limit          integer,
    p_lease_ttl_sec  integer,
    p_criados_desde  timestamptz
)
returns table (
    evento_id          uuid,
    organizacao_id     uuid,
    conexao_id         uuid,
    envio_id           uuid,
    ator_id            uuid,
    conversa_id_local  uuid,
    conversa_id_externo text,
    conteudo           text,
    correlation_id     text,
    fencing_token      bigint,
    lease_expires_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_worker_id is null or char_length(btrim(p_worker_id)) = 0 or char_length(p_worker_id) > 200 then
        raise exception 'p_worker_id invalido.' using errcode = '22023';
    end if;
    if p_limit is null or p_limit < 1 or p_limit > 50 then
        raise exception 'p_limit fora de 1..50.' using errcode = '22023';
    end if;
    if p_lease_ttl_sec is null or p_lease_ttl_sec < 5 or p_lease_ttl_sec > 300 then
        raise exception 'p_lease_ttl_sec fora de 5..300.' using errcode = '22023';
    end if;
    if p_criados_desde is null then
        raise exception 'MSG-008: o claim exige o corte do backlog.' using errcode = '22023';
    end if;

    return query
    with lote as (
        select o.id
          from public.outbox_eventos o
          join public.chatwoot_envios e on e.organizacao_id = o.organizacao_id and e.outbox_evento_id = o.id
         where o.destination = 'chatwoot'
           and o.event_type = 'message.send'
           and o.status in ('pending', 'failed_transient')
           and o.next_retry_at <= now()
           and e.created_at >= p_criados_desde
         order by o.next_retry_at asc, o.created_at asc
         limit p_limit
         for update of o skip locked
    ), reivindicados as (
        update public.outbox_eventos o
           set status = 'processing',
               lease_owner = p_worker_id,
               lease_expires_at = now() + make_interval(secs => p_lease_ttl_sec),
               updated_at = now()
          from lote
         where o.id = lote.id
        returning o.id, o.organizacao_id, o.correlation_id, o.fencing_token, o.lease_expires_at
    )
    select r.id, r.organizacao_id, e.conexao_id, e.id, e.ator_id, e.conversa_id_local, c.id_externo,
           e.conteudo, r.correlation_id, r.fencing_token, r.lease_expires_at
      from reivindicados r
      join public.chatwoot_envios e on e.organizacao_id = r.organizacao_id and e.outbox_evento_id = r.id
      join public.chatwoot_conversations c on c.organizacao_id = e.organizacao_id and c.id_local = e.conversa_id_local;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Conclusão: desfecho por fencing (MSG-007) e, com recibo, a mensagem
-- espelhada com proveniência, na mesma transação.
--
-- `p_mensagem` traz só o que o recibo do Chatwoot devolveu: `remetente_nome`,
-- `remetente_id`, `remetente_tipo`, `criada_em`. O id é o próprio recibo.
-- ---------------------------------------------------------------------------
create or replace function public.concluir_envio_chatwoot(
    p_evento_id        uuid,
    p_worker_id        text,
    p_fencing_token    bigint,
    p_desfecho         text,
    p_recibo_ref       text default null,
    p_motivo           text default null,
    p_erro             text default null,
    p_categoria        text default null,
    p_retry_delay_sec  integer default 10,
    p_mensagem         jsonb default null
)
returns table (status text, mensagem_id_local uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_envio     record;
    v_status    text;
    v_mensagem  uuid;
    v_criada_em timestamptz;
begin
    if p_desfecho = 'confirmado' and (p_recibo_ref is null or p_recibo_ref !~ '^[1-9][0-9]{0,9}$'
                                      or p_recibo_ref::bigint > 2147483647) then
        raise exception 'MSG-008: recibo do Chatwoot invalido.' using errcode = '22023';
    end if;

    select e.*, c.id_externo as conversa_id_externo into v_envio
      from public.chatwoot_envios e
      join public.chatwoot_conversations c on c.organizacao_id = e.organizacao_id and c.id_local = e.conversa_id_local
     where e.outbox_evento_id = p_evento_id
       for update of e;
    if not found then
        raise exception 'MSG-008: evento sem envio registrado.' using errcode = '22023';
    end if;

    v_status := public.concluir_tentativa_outbox(
        p_evento_id, p_worker_id, p_fencing_token, p_desfecho, p_recibo_ref,
        case when p_desfecho = 'confirmado' then jsonb_build_object('id', p_recibo_ref::bigint) end,
        p_motivo, p_erro, p_categoria, p_retry_delay_sec);

    if v_status is null then
        return query select null::text, null::uuid;
        return;
    end if;

    if v_status = 'sent' then
        v_criada_em := coalesce((p_mensagem ->> 'criada_em')::timestamptz, now());
        insert into public.chatwoot_messages as m
            (id, id_externo, organizacao_id, conexao_id, user_id, conversa_id_local, conversation_id, content,
             message_type, sender_name, sender_id, sender_type, created_at, envio_id)
        values (p_recibo_ref::integer, p_recibo_ref, v_envio.organizacao_id, v_envio.conexao_id, v_envio.ator_id,
                v_envio.conversa_id_local, v_envio.conversa_id_externo::integer, v_envio.conteudo, 'outgoing',
                left(coalesce(p_mensagem ->> 'remetente_nome', 'Atendente Orbita'), 200),
                nullif(p_mensagem ->> 'remetente_id', '')::integer,
                coalesce(nullif(p_mensagem ->> 'remetente_tipo', ''), 'user'),
                v_criada_em, v_envio.id)
        -- O webhook da própria resposta pode ter chegado antes: a linha já
        -- existe, e só ganha a proveniência.
        on conflict (organizacao_id, conexao_id, id_externo)
            do update set envio_id = coalesce(m.envio_id, excluded.envio_id)
        returning m.id_local into v_mensagem;

        update public.chatwoot_envios set mensagem_id_local = v_mensagem
         where id = v_envio.id and mensagem_id_local is null;

        perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'chatwoot.send_confirmed', v_envio.id,
            jsonb_build_object('conexao_id', v_envio.conexao_id, 'evento_id', p_evento_id));
    elsif v_status = 'dead_letter' then
        perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'chatwoot.send_rejected', v_envio.id,
            jsonb_build_object('conexao_id', v_envio.conexao_id, 'evento_id', p_evento_id, 'motivo', p_motivo));
    elsif v_status = 'unknown' then
        perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'outbox.effect_unknown', v_envio.id,
            jsonb_build_object('destino', 'chatwoot', 'tipo', 'message.send', 'evento_id', p_evento_id, 'motivo', p_motivo));
    end if;

    return query select v_status, v_mensagem;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Superfície: só o servidor.
-- ---------------------------------------------------------------------------
revoke all on function public.auditar_envio_chatwoot(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.registrar_envio_chatwoot(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.reivindicar_envios_chatwoot(text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.concluir_envio_chatwoot(uuid, text, bigint, text, text, text, text, text, integer, jsonb)
    from public, anon, authenticated;
grant execute on function public.registrar_envio_chatwoot(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.reivindicar_envios_chatwoot(text, integer, integer, timestamptz) to service_role;
grant execute on function public.concluir_envio_chatwoot(uuid, text, bigint, text, text, text, text, text, integer, jsonb)
    to service_role;

-- Autoverificação: nada desta migration fica acessível ao navegador.
do $$
begin
    if has_table_privilege('authenticated', 'public.chatwoot_envios', 'select')
       or has_table_privilege('anon', 'public.chatwoot_envios', 'select')
       or has_table_privilege('service_role', 'public.chatwoot_envios', 'insert')
       or has_function_privilege('authenticated', 'public.registrar_envio_chatwoot(uuid,uuid,uuid,uuid,text)', 'execute')
       or has_function_privilege('authenticated', 'public.reivindicar_envios_chatwoot(text,integer,integer,timestamptz)', 'execute')
       or has_function_privilege('authenticated',
              'public.concluir_envio_chatwoot(uuid,text,bigint,text,text,text,text,text,integer,jsonb)', 'execute') then
        raise exception 'MSG-008: superficie de envio exposta ao navegador.';
    end if;
end;
$$;
