-- MSG-022. Os números 93 e 94 pertencem aos PRs #148 e #149.
begin;
set local lock_timeout = '5s';

create table public.sac_politica_autorresposta (
    escopo text primary key,
    organizacao_id uuid references public.organizacoes(id) on delete cascade,
    ativa boolean not null default false,
    versao bigint not null default 0 check (versao >= 0),
    check ((organizacao_id is null and escopo = 'global') or
           (organizacao_id is not null and escopo = organizacao_id::text))
);

create table public.sac_operadores_autorresposta (
    ator_id uuid primary key references auth.users(id) on delete cascade
);

create table public.sac_historico_autorresposta (
    id bigint generated always as identity primary key,
    escopo text not null,
    ator_id uuid not null,
    motivo text not null check (char_length(motivo) between 1 and 240),
    ativa boolean not null,
    versao bigint not null,
    alterado_em timestamptz not null default clock_timestamp(),
    unique (escopo, versao)
);

alter table public.sac_politica_autorresposta enable row level security;
alter table public.sac_operadores_autorresposta enable row level security;
alter table public.sac_historico_autorresposta enable row level security;
revoke all on public.sac_politica_autorresposta, public.sac_operadores_autorresposta,
    public.sac_historico_autorresposta from public, anon, authenticated, service_role;

-- Identificadores históricos permanecem mesmo se a retenção apagar o run ou o caso.
-- As duas fronteiras SQL exigem as linhas de origem vigentes.
-- O executor automático é provisionado explicitamente por tenant. Remover
-- o membership revoga o grant, sem alterar as intenções já registradas.
create table public.sac_executores_autorresposta (
    organizacao_id uuid not null,
    ator_id uuid not null,
    primary key (organizacao_id, ator_id),
    foreign key (organizacao_id, ator_id)
        references public.membros_organizacao (organizacao_id, user_id) on delete cascade
);
alter table public.sac_executores_autorresposta enable row level security;
revoke all on public.sac_executores_autorresposta from public, anon, authenticated, service_role;

create function public.executor_autorresposta_ativo(p_organizacao_id uuid, p_ator_id uuid)
returns boolean language sql volatile set search_path = '' as $$
    select exists (
        select 1 from public.sac_executores_autorresposta e
        join public.organizacoes o on o.id = e.organizacao_id
        join public.membros_organizacao m on (m.organizacao_id, m.user_id) = (e.organizacao_id, e.ator_id)
        where e.organizacao_id = p_organizacao_id and e.ator_id = p_ator_id and o.status = 'active'
        for share of e, o, m
    );
$$;

-- A migration 94 é responsável pela versão da mensagem atualizada pela inbox.

-- A inbox atualiza a mesma linha do caso. FOR SHARE espera sua transação e
-- mantém a versão estável até o commit de enfileiramento ou de in_flight.
create function public.run_autorresposta_vigente(
    p_organizacao_id uuid, p_caso_id uuid, p_conversa_id uuid, p_run_id uuid
)
returns boolean language plpgsql set search_path = '' as $$
declare
    v_mensagens_ate timestamptz;
begin
    select c.ultima_mensagem_em into v_mensagens_ate from public.sac_cases c
     where c.organizacao_id = p_organizacao_id and c.id = p_caso_id and c.conversa_id_local = p_conversa_id
       and c.phase in ('TRIAGE', 'COLLECTING_INFORMATION')
     for share;
    if not found then return false; end if;

    perform 1 from public.ai_runs r
     where r.id = p_run_id and r.organizacao_id = p_organizacao_id and r.caso_id = p_caso_id
       and r.tarefa = 'sac.triagem' and r.status = 'concluida' and r.mensagens_ate = v_mensagens_ate
       and r.provedor <> 'fake' and r.chamou_modelo and r.resultado -> 'precisaDeHumano' = 'false'::jsonb
     for share;
    return found;
end;
$$;


alter table public.chatwoot_envios
    add column autorresposta_run_id uuid,
    add column autorresposta_caso_id uuid,
    add column autorresposta_versao_global bigint,
    add column autorresposta_versao_org bigint,
    add constraint ck_chatwoot_envio_autorresposta check (
        (autorresposta_run_id is null and autorresposta_caso_id is null and autorresposta_versao_global is null and autorresposta_versao_org is null)
        or (autorresposta_run_id is not null and autorresposta_caso_id is not null and autorresposta_versao_global is not null
            and autorresposta_versao_org is not null and not privada)
    );

create index ix_chatwoot_envios_autorresposta on public.chatwoot_envios (organizacao_id, outbox_evento_id)
    where autorresposta_run_id is not null;

create function public.proteger_origem_autorresposta()
returns trigger language plpgsql set search_path = '' as $$
begin
    if (new.autorresposta_run_id, new.autorresposta_caso_id, new.autorresposta_versao_global, new.autorresposta_versao_org)
        is distinct from (old.autorresposta_run_id, old.autorresposta_caso_id, old.autorresposta_versao_global, old.autorresposta_versao_org) then
        raise exception 'Origem da autorresposta imutavel.' using errcode = '23514';
    end if;
    return new;
end;
$$;
create trigger tg_chatwoot_envios_origem_autorresposta
    before update on public.chatwoot_envios for each row execute function public.proteger_origem_autorresposta();

-- Todos os escritores da política usam global → organização. Locks de
-- transação também protegem o estado ausente, que equivale a desligado.
create function public.travar_politica_autorresposta(p_organizacao_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
    perform pg_advisory_xact_lock_shared(hashtextextended('sac.autorresposta.global', 0));
    perform pg_advisory_xact_lock_shared(hashtextextended('sac.autorresposta:' || p_organizacao_id::text, 0));
end;
$$;

create function public.estado_autorresposta(p_organizacao_id uuid)
returns table (ativa_global boolean, versao_global bigint, ativa_org boolean, versao_org bigint)
language sql stable set search_path = '' as $$
    select coalesce(g.ativa, false), coalesce(g.versao, 0), coalesce(o.ativa, false), coalesce(o.versao, 0)
      from (values (1)) as base(n)
      left join public.sac_politica_autorresposta g on g.escopo = 'global'
      left join public.sac_politica_autorresposta o on o.escopo = p_organizacao_id::text;
$$;

create function public.pode_gerir_autorresposta(p_organizacao_id uuid, p_ator_id uuid)
returns boolean language sql volatile set search_path = '' as $$
    select case when p_organizacao_id is null then exists (
        select 1 from public.sac_operadores_autorresposta where ator_id = p_ator_id for share
    ) else exists (
        select 1 from public.membros_organizacao m join public.organizacoes o on o.id = m.organizacao_id
         where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id
           and m.papel in ('owner', 'admin') and o.status = 'active' for share of m, o
    ) end;
$$;

create function public.ler_politica_autorresposta(p_organizacao_id uuid, p_ator_id uuid)
returns table (ativa_global boolean, versao_global bigint, ativa_org boolean, versao_org bigint)
language plpgsql security definer set search_path = '' as $$
begin
    if not public.pode_gerir_autorresposta(p_organizacao_id, p_ator_id) then
        raise exception 'Sem permissao para autorresposta.' using errcode = '42501';
    end if;
    return query select * from public.estado_autorresposta(p_organizacao_id);
end;
$$;

-- O evento da outbox é a fonte do estado terminal. Atualizá-lo sem travar a
-- intenção evita inverter a ordem da conclusão existente (intenção → evento).
create function public.invalidar_autorresposta(p_evento_id uuid)
returns void language plpgsql set search_path = '' as $$
declare
    v_envio record;
begin
    update public.outbox_eventos
       set status = 'processing', lease_owner = 'msg022:invalidacao',
           lease_expires_at = clock_timestamp(), updated_at = clock_timestamp()
     where id = p_evento_id and status = 'failed_transient';

    update public.outbox_eventos
       set status = 'dead_letter', last_error = 'autorresposta_invalidada',
           last_error_category = 'permanent', lease_owner = null,
           lease_expires_at = null, updated_at = clock_timestamp()
     where id = p_evento_id and status in ('pending', 'processing');
    if found then
        select id, organizacao_id into strict v_envio
          from public.chatwoot_envios where outbox_evento_id = p_evento_id;
        perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'chatwoot.send_invalidated',
            v_envio.id, jsonb_build_object('evento_id', p_evento_id, 'motivo', 'autorresposta_invalidada'));
    end if;
end;
$$;

create function public.alterar_politica_autorresposta(
    p_organizacao_id uuid, p_ator_id uuid, p_ativa boolean, p_versao bigint, p_motivo text
)
returns text language plpgsql security definer set search_path = '' as $$
declare
    v_escopo text := coalesce(p_organizacao_id::text, 'global');
    v_versao bigint;
    v_evento uuid;
begin
    if p_ativa is null or p_versao is null or p_versao < 0 or p_motivo is null
       or char_length(btrim(p_motivo)) not between 1 and 240 then
        raise exception 'Comando de autorresposta invalido.' using errcode = '22023';
    end if;
    if not public.pode_gerir_autorresposta(p_organizacao_id, p_ator_id) then
        return 'sem_permissao';
    end if;

    if p_organizacao_id is null then
        perform pg_advisory_xact_lock(hashtextextended('sac.autorresposta.global', 0));
    else
        perform pg_advisory_xact_lock_shared(hashtextextended('sac.autorresposta.global', 0));
        perform pg_advisory_xact_lock(hashtextextended('sac.autorresposta:' || p_organizacao_id::text, 0));
    end if;

    select versao into v_versao from public.sac_politica_autorresposta where escopo = v_escopo;
    if coalesce(v_versao, 0) <> p_versao then
        return 'conflito';
    end if;

    insert into public.sac_politica_autorresposta (escopo, organizacao_id, ativa, versao)
    values (v_escopo, p_organizacao_id, p_ativa, p_versao + 1)
    on conflict (escopo) do update set ativa = excluded.ativa, versao = excluded.versao;

    insert into public.sac_historico_autorresposta (escopo, ator_id, motivo, ativa, versao)
    values (v_escopo, p_ator_id, btrim(p_motivo), p_ativa, p_versao + 1);

    -- Mudança de versão cerca trabalhos anteriores. Em voo e UNKNOWN permanecem
    -- disponíveis para conclusão ou reconciliação.
    for v_evento in
        select o.id from public.chatwoot_envios e
        join public.outbox_eventos o on o.organizacao_id = e.organizacao_id and o.id = e.outbox_evento_id
        where e.autorresposta_run_id is not null
          and (p_organizacao_id is null or e.organizacao_id = p_organizacao_id)
          and o.status in ('pending', 'processing', 'failed_transient')
        order by o.id for update of o
    loop
        perform public.invalidar_autorresposta(v_evento);
    end loop;
    return 'aplicado';
end;
$$;

-- Porta do MSG-014, acessível só no servidor. O executor passou pela
-- autenticação do job e pela validação de grounding/frescor antes desta RPC.
create function public.registrar_autorresposta_chatwoot(
    p_organizacao_id uuid, p_ator_id uuid, p_conversa_id uuid, p_caso_id uuid, p_command_id uuid,
    p_run_id uuid, p_conteudo text, p_versao_global bigint, p_versao_org bigint,
    p_versao_conversa bigint
)
returns text language plpgsql security definer set search_path = '' as $$
declare
    v_politica record;
    v_controle public.chatwoot_conversa_controle;
    v_conexao uuid;
    v_evento uuid;
    v_envio uuid;
    v_digest text;
    v_existente record;
begin
    if p_organizacao_id is null or p_ator_id is null or p_conversa_id is null
       or p_caso_id is null or p_command_id is null or p_run_id is null or p_versao_global is null
       or p_versao_org is null or p_versao_conversa is null
       or p_conteudo is null or p_conteudo <> btrim(p_conteudo)
       or char_length(p_conteudo) not between 1 and 4096 then
        raise exception 'Comando de resposta IA invalido.' using errcode = '22023';
    end if;

    perform public.travar_politica_autorresposta(p_organizacao_id);
    if not public.executor_autorresposta_ativo(p_organizacao_id, p_ator_id) then
        return 'executor_nao_autorizado';
    end if;
    select * into strict v_politica from public.estado_autorresposta(p_organizacao_id);
    if not (v_politica.ativa_global and v_politica.ativa_org) then return 'desligada'; end if;
    if (v_politica.versao_global, v_politica.versao_org) <> (p_versao_global, p_versao_org) then
        return 'obsoleta';
    end if;

    select c.conexao_id into v_conexao from public.chatwoot_conversations c
      join public.conexoes_integracao i on i.id = c.conexao_id and i.organizacao_id = c.organizacao_id
     where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id
       and i.provedor = 'chatwoot' and i.status <> 'desconectado';
    if not found then return 'conexao_indisponivel'; end if;

    v_digest := encode(pg_catalog.sha256(convert_to(jsonb_build_array(
        p_conversa_id, p_caso_id, p_run_id, p_ator_id, p_conteudo, p_versao_global, p_versao_org, p_versao_conversa
    )::text, 'UTF8')), 'hex');
    perform pg_advisory_xact_lock(hashtextextended('chatwoot_envio:' || p_organizacao_id::text || ':' || p_command_id::text, 0));
    select e.payload_digest, e.autorresposta_run_id into v_existente from public.chatwoot_envios e
     where e.organizacao_id = p_organizacao_id and e.command_id = p_command_id;
    if found then
        if v_existente.autorresposta_run_id = p_run_id and v_existente.payload_digest = v_digest then
            return 'existente';
        end if;
        return 'conflito';
    end if;

    v_controle := public.travar_controle_chatwoot(p_organizacao_id, p_conversa_id, false);
    if v_controle.ownership_mode <> 'AI' or v_controle.control_version <> p_versao_conversa then
        return 'obsoleta';
    end if;

    if not public.run_autorresposta_vigente(p_organizacao_id, p_caso_id, p_conversa_id, p_run_id) then
        return 'run_inelegivel';
    end if;

    select r.evento_id into v_evento from public.registrar_evento_outbox(
        p_organizacao_id, v_conexao, p_ator_id, 'chatwoot.message.send:' || p_command_id::text,
        'chatwoot', 'message.send', jsonb_build_object('command_id', p_command_id,
        'conversa_id_local', p_conversa_id, 'conexao_id', v_conexao, 'payload_digest', v_digest), 5
    ) r where not r.is_duplicate;
    if v_evento is null then raise exception 'Intencao duplicada.' using errcode = '23505'; end if;

    insert into public.chatwoot_envios (
        organizacao_id, conexao_id, conversa_id_local, command_id, payload_digest, conteudo, ator_id,
        outbox_evento_id, controle_versao, autorresposta_run_id, autorresposta_caso_id, autorresposta_versao_global, autorresposta_versao_org
    ) values (
        p_organizacao_id, v_conexao, p_conversa_id, p_command_id, v_digest, p_conteudo, p_ator_id,
        v_evento, p_versao_conversa, p_run_id, p_caso_id, p_versao_global, p_versao_org
    ) returning id into v_envio;
    perform public.auditar_envio_chatwoot(p_organizacao_id, null, 'chatwoot.send_requested', v_envio,
        jsonb_build_object('evento_id', v_evento, 'origem', 'ia', 'run_id', p_run_id));
    return 'registrada';
end;
$$;
create or replace function public.iniciar_envio_chatwoot(
    p_evento_id     uuid,
    p_worker_id     text,
    p_fencing_token bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_envio    record;
    v_controle public.chatwoot_conversa_controle;
    v_evento   record;
    v_politica record;
    v_autorizada boolean;
begin
    select e.id, e.organizacao_id, e.conexao_id, e.conversa_id_local, e.controle_versao, e.privada,
           e.ator_id, e.autorresposta_run_id, e.autorresposta_caso_id, e.autorresposta_versao_global, e.autorresposta_versao_org into v_envio
      from public.chatwoot_envios e
     where e.outbox_evento_id = p_evento_id;
    if not found then
        raise exception 'MSG-009: evento sem envio registrado.' using errcode = '22023';
    end if;

    if v_envio.autorresposta_run_id is not null then
        perform public.travar_politica_autorresposta(v_envio.organizacao_id);
        select * into strict v_politica from public.estado_autorresposta(v_envio.organizacao_id);
        v_autorizada := public.executor_autorresposta_ativo(v_envio.organizacao_id, v_envio.ator_id);
    end if;

    if not v_envio.privada then
        v_controle := public.travar_controle_chatwoot(v_envio.organizacao_id, v_envio.conversa_id_local, true);
    end if;

    if v_envio.autorresposta_run_id is not null and v_autorizada then
        v_autorizada := public.run_autorresposta_vigente(v_envio.organizacao_id, v_envio.autorresposta_caso_id,
            v_envio.conversa_id_local, v_envio.autorresposta_run_id);
    end if;

    select o.* into v_evento from public.outbox_eventos o where o.id = p_evento_id for update;
    if not found
       or v_evento.status <> 'processing'
       or v_evento.lease_owner is distinct from p_worker_id
       or v_evento.fencing_token is distinct from p_fencing_token
       or v_evento.lease_expires_at is null
       or v_evento.lease_expires_at < clock_timestamp() then
        return 'posse_perdida';
    end if;

    if v_envio.autorresposta_run_id is not null then
        if not v_autorizada or not (v_politica.ativa_global and v_politica.ativa_org)
           or (v_politica.versao_global, v_politica.versao_org)
                <> (v_envio.autorresposta_versao_global, v_envio.autorresposta_versao_org)
           or v_controle.ownership_mode <> 'AI' then
            perform public.invalidar_autorresposta(p_evento_id);
            return 'invalidado';
        end if;
    end if;

    if not v_envio.privada then
        if v_controle.control_version <> v_envio.controle_versao then
            update public.outbox_eventos
               set status = 'dead_letter',
                   last_error = 'Envio invalidado: o controle do atendimento mudou antes do despacho.',
                   last_error_category = 'permanent',
                   attempts = v_evento.attempts + 1,
                   lease_owner = null, lease_expires_at = null, updated_at = now()
             where id = p_evento_id;
            update public.chatwoot_envios set invalidado_em = now() where id = v_envio.id and invalidado_em is null;
            perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'chatwoot.send_invalidated', v_envio.id,
                jsonb_build_object('conexao_id', v_envio.conexao_id, 'evento_id', p_evento_id,
                                   'versao_vigente', v_controle.control_version));
            return 'invalidado';
        end if;
    end if;

    update public.outbox_eventos
       set status = 'in_flight', despachado_em = now(), updated_at = now()
     where id = p_evento_id;
    insert into public.outbox_tentativas (organizacao_id, evento_id, fencing_token, worker_id)
    values (v_evento.organizacao_id, v_evento.id, v_evento.fencing_token, p_worker_id);
    return 'iniciado';
end;
$$;

-- Um efeito IA ambíguo continua conciliável por recibo. Se o efeito não
-- ocorreu, uma nova geração deve revalidar dados, política e controle.
create function public.impedir_replay_autorresposta()
returns trigger language plpgsql set search_path = '' as $$
begin
    if old.status = 'unknown' and new.status = 'pending' and exists (
        select 1 from public.chatwoot_envios e
         where e.organizacao_id = old.organizacao_id and e.outbox_evento_id = old.id
           and e.autorresposta_run_id is not null
    ) then
        raise exception 'Autorresposta exige nova geracao apos reconciliacao.' using errcode = '55000';
    end if;
    return new;
end;
$$;

create trigger tg_outbox_impedir_replay_autorresposta
    before update of status on public.outbox_eventos
    for each row execute function public.impedir_replay_autorresposta();

alter function public.estado_autorresposta(uuid) security definer;
revoke all on function public.executor_autorresposta_ativo(uuid, uuid), public.run_autorresposta_vigente(uuid, uuid, uuid, uuid),
    public.proteger_origem_autorresposta(),
    public.travar_politica_autorresposta(uuid), public.pode_gerir_autorresposta(uuid, uuid),
    public.invalidar_autorresposta(uuid), public.impedir_replay_autorresposta(),
    public.estado_autorresposta(uuid), public.ler_politica_autorresposta(uuid, uuid),
    public.alterar_politica_autorresposta(uuid, uuid, boolean, bigint, text),
    public.registrar_autorresposta_chatwoot(uuid, uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, bigint)
    from public, anon, authenticated, service_role;

grant execute on function public.estado_autorresposta(uuid), public.ler_politica_autorresposta(uuid, uuid),
    public.alterar_politica_autorresposta(uuid, uuid, boolean, bigint, text),
    public.registrar_autorresposta_chatwoot(uuid, uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, bigint)
    to service_role;

commit;
