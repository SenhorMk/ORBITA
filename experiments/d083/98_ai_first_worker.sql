-- Candidate after D08.2. Privileged coordination stays outside the browser.
create table public.chatwoot_ai_runtime (
    conexao_id uuid primary key references public.conexoes_integracao(id) on delete cascade,
    organizacao_id uuid not null references public.organizacoes(id),
    executor_id uuid not null references auth.users(id),
    corte timestamptz not null,
    ativo boolean not null default false,
    pronto_ate timestamptz not null default '-infinity'
);
create table public.chatwoot_ai_projecao (
    organizacao_id uuid not null,
    conversa_id uuid not null,
    versao bigint,
    desejado text check (desejado in ('open','pending')),
    fase text not null default 'novo' check (fase in ('novo','lendo','escrevendo','incerto','ok','contido')),
    ate timestamptz,
    token uuid,
    observado_seq bigint not null default 0,
    somente_leitura boolean not null default false,
    atualizado_em timestamptz not null default now(),
    primary key (organizacao_id, conversa_id),
    foreign key (organizacao_id, conversa_id)
        references public.chatwoot_conversations(organizacao_id,id_local) on delete cascade
);
create table public.chatwoot_ai_geracao (
    organizacao_id uuid not null,
    caso_id uuid not null,
    mensagens_ate timestamptz not null,
    token uuid not null,
    ate timestamptz not null,
    resultado text,
    primary key (organizacao_id,caso_id,mensagens_ate),
    foreign key (organizacao_id,caso_id) references public.sac_cases(organizacao_id,id) on delete cascade
);
alter table public.chatwoot_ai_runtime enable row level security;
alter table public.chatwoot_ai_projecao enable row level security;
alter table public.chatwoot_ai_geracao enable row level security;
revoke all on public.chatwoot_ai_runtime, public.chatwoot_ai_projecao, public.chatwoot_ai_geracao
    from public, anon, authenticated, service_role;

-- Admission and outbound authorization linearize on the same scoped lock.
-- The inbox consumer keeps its existing leases, replay rules and transaction.
create sequence public.chatwoot_ai_ingresso_seq;
revoke all on sequence public.chatwoot_ai_ingresso_seq from public, anon, authenticated, service_role;
alter table public.inbox_eventos_chatwoot add column ai_ingresso bigint not null default 0;

create function public.travar_ingresso_ai(p_conexao uuid) returns void
language sql set search_path = '' as $$
    select pg_advisory_xact_lock(hashtextextended('chatwoot.ai.ingresso:' || p_conexao::text,0))
$$;
create function public.marcar_ingresso_ai() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if new.conexao_id is not null and new.event_type in
        ('message_created','message_updated','conversation_status_changed','conversation_updated','conversation_created') then
        perform public.travar_ingresso_ai(new.conexao_id);
        new.ai_ingresso := nextval('public.chatwoot_ai_ingresso_seq');
    end if;
    return new;
end
$$;
create trigger tg_chatwoot_ai_ingresso before insert on public.inbox_eventos_chatwoot
for each row execute function public.marcar_ingresso_ai();

create index ix_chatwoot_ai_ingresso on public.inbox_eventos_chatwoot
    (organizacao_id, conexao_id, (payload #>> '{conversation,id}'), ai_ingresso)
    where event_type in ('message_created','message_updated','conversation_status_changed','conversation_updated','conversation_created');

create function public.ai_inbox_pendente(p_org uuid,p_conexao uuid,p_externo text) returns boolean
language sql stable set search_path = '' as $$
    select exists (
        select 1 from public.inbox_eventos_chatwoot e
         where e.organizacao_id=p_org and e.conexao_id=p_conexao
           and e.event_type in ('message_created','message_updated','conversation_status_changed','conversation_updated','conversation_created')
           and e.status in ('received','processing','failed')
           and (e.payload #>> '{conversation,id}' is null or e.payload #>> '{conversation,id}'=p_externo)
    )
$$;

create function public.ai_seq_observacao(p_org uuid,p_conexao uuid,p_externo text) returns bigint
language sql stable set search_path = '' as $$
    select coalesce(max(e.ai_ingresso),0) from public.inbox_eventos_chatwoot e
     where e.organizacao_id=p_org and e.conexao_id=p_conexao
       and e.event_type in ('conversation_status_changed','conversation_updated')
       and (e.payload #>> '{conversation,id}' is null or e.payload #>> '{conversation,id}'=p_externo)
$$;

create function public.ai_runtime_valido(p_org uuid,p_conexao uuid,p_executor uuid) returns boolean
language sql volatile set search_path = '' as $$
    select exists (
        select 1 from public.chatwoot_ai_runtime r join public.conexoes_integracao c
          on c.id=r.conexao_id and c.organizacao_id=r.organizacao_id
        where r.conexao_id=p_conexao and r.organizacao_id=p_org and r.executor_id=p_executor
          and r.ativo and r.pronto_ate>clock_timestamp() and c.provedor='chatwoot' and c.status='conectado'
        for share of r,c
    )
$$;

create function public.renovar_worker_ai_first(p_org uuid,p_conexao uuid,p_executor uuid,p_pronto boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
    if p_pronto and not public.executor_autorresposta_ativo(p_org,p_executor) then return false; end if;
    update public.chatwoot_ai_runtime set pronto_ate=case when p_pronto then clock_timestamp()+interval '30 seconds' else '-infinity' end
     where organizacao_id=p_org and conexao_id=p_conexao and executor_id=p_executor and ativo;
    return found;
end
$$;

alter function public.iniciar_envio_chatwoot(uuid,text,bigint) rename to iniciar_envio_chatwoot_msg022;
revoke all on function public.iniciar_envio_chatwoot_msg022(uuid,text,bigint) from public,anon,authenticated,service_role;
create function public.iniciar_envio_chatwoot(p_evento_id uuid,p_worker_id text,p_fencing_token bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare
    v record;
begin
    select e.*, c.id_externo into v from public.chatwoot_envios e
      join public.chatwoot_conversations c on c.organizacao_id=e.organizacao_id and c.id_local=e.conversa_id_local
     where e.outbox_evento_id=p_evento_id;
    if v.autorresposta_run_id is null then
        return public.iniciar_envio_chatwoot_msg022(p_evento_id,p_worker_id,p_fencing_token);
    end if;
    if not exists (select 1 from public.outbox_eventos
        where id=p_evento_id and status='processing' and lease_owner=p_worker_id
          and fencing_token=p_fencing_token and lease_expires_at>clock_timestamp()) then return 'posse_perdida'; end if;
    perform public.travar_ingresso_ai(v.conexao_id);
    if not public.ai_runtime_valido(v.organizacao_id,v.conexao_id,v.ator_id)
       or public.ai_inbox_pendente(v.organizacao_id,v.conexao_id,v.id_externo)
       or not exists (select 1 from public.chatwoot_ai_projecao p
           where p.organizacao_id=v.organizacao_id and p.conversa_id=v.conversa_id_local
             and p.versao=v.controle_versao and p.desejado='pending' and p.fase='ok'
             and p.atualizado_em>clock_timestamp()-interval '2 minutes'
             and p.observado_seq=public.ai_seq_observacao(v.organizacao_id,v.conexao_id,v.id_externo)) then
        -- Leave the existing lease intact. The normal claim reaper will
        -- revisit it. No attempt or external effect happened.
        return 'aguardando_ai_first';
    end if;
    return public.iniciar_envio_chatwoot_msg022(p_evento_id,p_worker_id,p_fencing_token);
end
$$;
revoke all on function public.iniciar_envio_chatwoot(uuid,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.iniciar_envio_chatwoot(uuid,text,bigint) to service_role;

revoke all on function public.travar_ingresso_ai(uuid),public.marcar_ingresso_ai(),
    public.ai_inbox_pendente(uuid,uuid,text),public.ai_seq_observacao(uuid,uuid,text),public.ai_runtime_valido(uuid,uuid,uuid),
    public.renovar_worker_ai_first(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.renovar_worker_ai_first(uuid,uuid,uuid,boolean) to service_role;

create function public.ai_contexto_worker(p_org uuid,p_conexao uuid,p_executor uuid)
returns table(caso uuid, conversa uuid, ate timestamptz, run uuid, versao bigint,
    versao_global bigint, versao_org bigint, intencao text)
language sql stable set search_path = '' as $$
    select s.id,c.id_local,s.ultima_mensagem_em,r.id,k.control_version,
           flags.versao_global,flags.versao_org,r.resultado->>'intencao'
    from public.chatwoot_conversations c
    join public.chatwoot_conversa_controle k on k.organizacao_id=c.organizacao_id and k.conversa_id_local=c.id_local
    join public.chatwoot_ai_projecao p on p.organizacao_id=c.organizacao_id and p.conversa_id=c.id_local
    join public.sac_cases s on s.organizacao_id=c.organizacao_id and s.conversa_id_local=c.id_local
    cross join lateral public.estado_autorresposta(p_org) flags
    cross join lateral (select a.id,a.resultado from public.ai_runs a
        where a.organizacao_id=s.organizacao_id and a.caso_id=s.id and a.mensagens_ate=s.ultima_mensagem_em
          and a.tarefa='sac.triagem'
        order by a.sequencia desc limit 1) r
    where c.organizacao_id=p_org and c.conexao_id=p_conexao
      and k.ownership_mode='AI' and s.phase in ('TRIAGE','COLLECTING_INFORMATION')
      and flags.ativa_global and flags.ativa_org
      and p.versao=k.control_version and p.desejado='pending' and p.fase='ok'
      and p.atualizado_em>now()-interval '2 minutes'
      and p.observado_seq=public.ai_seq_observacao(p_org,p_conexao,c.id_externo)
      and not public.ai_inbox_pendente(p_org,p_conexao,c.id_externo)
      and r.resultado->'precisaDeHumano'='false'::jsonb
      and length(r.resultado->>'intencao') between 1 and 60
      and not exists (select 1 from public.chatwoot_controle_historico h
          where h.organizacao_id=p_org and h.conversa_id_local=c.id_local and h.acao='devolver'
            and h.versao_resultante=k.control_version and h.created_at>=s.ultima_mensagem_em)
      and not exists (select 1 from public.chatwoot_envios e join public.outbox_eventos o on o.id=e.outbox_evento_id
          where e.organizacao_id=p_org and e.conversa_id_local=c.id_local and e.autorresposta_run_id is not null
            and o.status in ('in_flight','unknown'))
$$;

create function public.reivindicar_geracao_ai_first(p_org uuid,p_conexao uuid,p_executor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v record;
    v_token uuid;
    v_mensagens jsonb;
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor)
       or not public.executor_autorresposta_ativo(p_org,p_executor) then return null; end if;
    select d.* into v from public.ai_contexto_worker(p_org,p_conexao,p_executor) d
     where not exists (select 1 from public.chatwoot_ai_geracao g
         where g.organizacao_id=p_org and g.caso_id=d.caso and g.mensagens_ate=d.ate
           and (g.resultado is not null or g.ate>clock_timestamp()))
     order by d.ate,d.caso limit 1;
    if not found or not public.run_autorresposta_vigente(p_org,v.caso,v.conversa,v.run) then return null; end if;
    select jsonb_agg(jsonb_build_object('conteudo',m.content,'criadaEm',m.created_at) order by m.created_at,m.id_local)
      into v_mensagens
      from (select content, created_at, id_local from public.chatwoot_messages
             where organizacao_id=p_org and conexao_id=p_conexao and conversa_id_local=v.conversa
               and message_type='incoming' and sender_type='contact' and content is not null
             order by created_at desc,id_local desc limit 5) m;
    if v_mensagens is null then return null; end if;
    insert into public.chatwoot_ai_geracao as g
        (organizacao_id,caso_id,mensagens_ate,token,ate)
    values (p_org,v.caso,v.ate,gen_random_uuid(),clock_timestamp()+interval '25 seconds')
    on conflict (organizacao_id,caso_id,mensagens_ate) do update set token=excluded.token,ate=excluded.ate
      where g.resultado is null and g.ate<=clock_timestamp()
    returning token into v_token;
    if v_token is null then return null; end if;
    return to_jsonb(v) || jsonb_build_object('token',v_token,'mensagens',v_mensagens,
       'resumo', (select h.nota from public.chatwoot_controle_historico h
          where h.organizacao_id=p_org and h.conversa_id_local=v.conversa
            and h.versao_resultante=v.versao and h.acao='devolver'
          order by h.created_at desc limit 1));
end
$$;

create function public.concluir_geracao_ai_first(
    p_org uuid,p_conexao uuid,p_executor uuid,p_token uuid,p_caso uuid,p_conversa uuid,p_run uuid,
    p_versao bigint,p_global bigint,p_org_versao bigint,p_texto text
) returns text language plpgsql security definer set search_path = '' as $$
declare
    v record;
    v_resultado text;
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor) then return 'indisponivel'; end if;
    select d.* into v from public.ai_contexto_worker(p_org,p_conexao,p_executor) d
      join public.chatwoot_ai_geracao g on g.organizacao_id=p_org and g.caso_id=d.caso and g.mensagens_ate=d.ate
     where d.caso=p_caso and d.conversa=p_conversa and d.run=p_run
       and (d.versao,d.versao_global,d.versao_org)=(p_versao,p_global,p_org_versao)
       and g.token=p_token and g.resultado is null and g.ate>clock_timestamp() for update of g;
    if not found then return 'obsoleta'; end if;
    if p_texto is null then
        select q.resultado into v_resultado from public.alterar_controle_atendimento_chatwoot(
            p_org,p_executor,p_conversa,p_token,'exigir_humano',p_versao,'Geração automática indisponível.') q;
        if v_resultado='aplicado' then v_resultado:='escalonada'; end if;
    else
        v_resultado := public.registrar_autorresposta_chatwoot(
            p_org,p_executor,p_conversa,p_caso,p_token,p_run,p_texto,p_global,p_org_versao,p_versao);
    end if;
    update public.chatwoot_ai_geracao set resultado=v_resultado where organizacao_id=p_org and caso_id=p_caso and token=p_token;
    return v_resultado;
end
$$;
revoke all on function public.ai_contexto_worker(uuid,uuid,uuid),
    public.reivindicar_geracao_ai_first(uuid,uuid,uuid),
    public.concluir_geracao_ai_first(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,bigint,bigint,text)
    from public,anon,authenticated,service_role;
grant execute on function public.reivindicar_geracao_ai_first(uuid,uuid,uuid),
    public.concluir_geracao_ai_first(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,bigint,bigint,text) to service_role;

-- Leases before a write are retryable. Once admitted, a missing receipt
-- permits readback only, even after the worker dies or ownership changes.
create function public.reivindicar_projecao_ai_first(p_org uuid,p_conexao uuid,p_executor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v record;
    r public.chatwoot_ai_projecao;
    v_flags record;
    v_token uuid := gen_random_uuid();
    v_desejado text;
    v_reconciliar boolean;
    v_somente_leitura boolean;
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor)
       or not public.executor_autorresposta_ativo(p_org,p_executor) then return null; end if;
    select * into strict v_flags from public.estado_autorresposta(p_org);
    select c.id_local,c.id_externo,c.inbox_id,i.account_id,coalesce(k.control_version,0) as versao,
           coalesce(k.ownership_mode,'HUMAN_REQUIRED') as modo, prova.id as evidencia,t.corte,
           public.ai_seq_observacao(p_org,p_conexao,c.id_externo) as seq
      into v
      from public.chatwoot_conversations c
      join public.chatwoot_inboxes i on i.organizacao_id=c.organizacao_id and i.conexao_id=c.conexao_id and i.inbox_id=c.inbox_id
      join public.chatwoot_ai_runtime t on t.organizacao_id=c.organizacao_id and t.conexao_id=c.conexao_id
      left join public.chatwoot_conversa_controle k on k.organizacao_id=c.organizacao_id and k.conversa_id_local=c.id_local
      left join public.chatwoot_ai_projecao p on p.organizacao_id=c.organizacao_id and p.conversa_id=c.id_local
      left join lateral (
        select e.id from public.inbox_eventos_chatwoot e
         where e.organizacao_id=p_org and e.conexao_id=p_conexao and e.inbox_id=c.inbox_id
           and e.event_type='conversation_created' and e.payload #>> '{conversation,id}'=c.id_externo
           and e.payload #>> '{account,id}'=i.account_id::text
           and e.payload #>> '{conversation,inbox_id}'=c.inbox_id::text
           and e.payload #> '{conversation,assignee_id}'='null'::jsonb and e.created_at>=t.corte
           and case when e.payload #>> '{conversation,created_at}' ~ '^[0-9]{10}([.][0-9]{1,6})?$'
               then to_timestamp((e.payload #>> '{conversation,created_at}')::double precision)>=greatest(t.corte,now()-interval '10 minutes')
                and to_timestamp((e.payload #>> '{conversation,created_at}')::double precision)<=now()+interval '5 seconds'
               else false end
         order by e.ai_ingresso limit 1
      ) prova on coalesce(k.control_version,0)=0 and v_flags.ativa_global and v_flags.ativa_org
        and not coalesce(p.versao=0 and p.fase='contido',false)
      where c.organizacao_id=p_org and c.conexao_id=p_conexao
        and (p.conversa_id is not null or k.ownership_mode='AI' or (prova.id is not null and exists (
            select 1 from public.sac_cases s where s.organizacao_id=p_org and s.conversa_id_local=c.id_local)))
        and (p.ate is null or p.ate<=clock_timestamp())
        and (p.fase is null or p.fase not in ('ok','contido') or p.versao is distinct from coalesce(k.control_version,0)
            or p.observado_seq<>public.ai_seq_observacao(p_org,p_conexao,c.id_externo)
            or (p.fase='ok' and p.atualizado_em<=now()-interval '60 seconds')
            or (p.fase='contido' and p.versao=0 and p.desejado='pending')
            or (p.desejado='pending' and not (v_flags.ativa_global and v_flags.ativa_org)))
        and not public.ai_inbox_pendente(p_org,p_conexao,c.id_externo)
      order by p.atualizado_em nulls first,c.id_local limit 1;
    if not found then return null; end if;
    select * into r from public.chatwoot_ai_projecao where organizacao_id=p_org and conversa_id=v.id_local;
    v_reconciliar := coalesce(r.fase in ('escrevendo','incerto'),false);
    v_desejado := case when v_reconciliar then r.desejado
         when v_flags.ativa_global and v_flags.ativa_org and (v.modo='AI' or v.evidencia is not null) then 'pending'
         else 'open' end;
    v_somente_leitura := v_reconciliar or coalesce(r.versao=v.versao and r.desejado=v_desejado
        and (r.fase in ('ok','contido') or (r.fase='lendo' and r.somente_leitura)),false);
    insert into public.chatwoot_ai_projecao as p
        (organizacao_id,conversa_id,versao,desejado,fase,ate,token,observado_seq,atualizado_em,somente_leitura)
    values (p_org,v.id_local,v.versao,v_desejado,'lendo',clock_timestamp()+interval '20 seconds',v_token,v.seq,now(),v_somente_leitura)
    on conflict (organizacao_id,conversa_id) do update set
        versao=case when v_reconciliar then p.versao else excluded.versao end,
        desejado=excluded.desejado,fase=case when v_reconciliar then 'incerto' else 'lendo' end,
        ate=excluded.ate,token=excluded.token,observado_seq=excluded.observado_seq,atualizado_em=now(),
        somente_leitura=excluded.somente_leitura;
    return to_jsonb(v) || jsonb_build_object('token',v_token,'desejado',v_desejado,'somente_leitura',v_somente_leitura,
        'reconciliar',v_reconciliar,'global',v_flags.versao_global,'org_versao',v_flags.versao_org);
end
$$;

create function public.iniciar_projecao_ai_first(
    p_org uuid,p_conexao uuid,p_executor uuid,p_conversa uuid,p_token uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor) then return false; end if;
    update public.chatwoot_ai_projecao p set fase='escrevendo'
      from public.chatwoot_conversations c
     where p.organizacao_id=p_org and p.conversa_id=p_conversa and p.token=p_token and p.fase='lendo' and not p.somente_leitura
       and p.ate>clock_timestamp() and c.organizacao_id=p_org and c.id_local=p_conversa and c.conexao_id=p_conexao
       and p.versao=coalesce((select k.control_version from public.chatwoot_conversa_controle k
           where k.organizacao_id=p_org and k.conversa_id_local=p_conversa),0)
       and not public.ai_inbox_pendente(p_org,p_conexao,c.id_externo)
       and p.observado_seq=public.ai_seq_observacao(p_org,p_conexao,c.id_externo)
       and (p.desejado='open' or exists (select 1 from public.estado_autorresposta(p_org) where ativa_global and ativa_org));
    return found;
end
$$;

create function public.concluir_projecao_ai_first(
    p_org uuid,p_conexao uuid,p_executor uuid,p_conversa uuid,p_token uuid,p_observado text,
    p_sem_responsavel boolean,p_evidencia uuid,p_global bigint,p_org_versao bigint
) returns text language plpgsql security definer set search_path = '' as $$
declare
    r public.chatwoot_ai_projecao;
    v record;
    v_versao bigint;
    v_resultado text;
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor) then return 'indisponivel'; end if;
    select c.id_externo,t.corte into v from public.chatwoot_conversations c
      join public.chatwoot_ai_runtime t on t.organizacao_id=c.organizacao_id and t.conexao_id=c.conexao_id
     where c.organizacao_id=p_org and c.id_local=p_conversa and c.conexao_id=p_conexao;
    if not found then return 'obsoleta'; end if;
    select * into r from public.chatwoot_ai_projecao where organizacao_id=p_org and conversa_id=p_conversa and token=p_token;
    if not found or r.ate<=clock_timestamp() then return 'obsoleta'; end if;
    if (p_observado is distinct from r.desejado or (r.desejado='pending' and p_sem_responsavel is distinct from true)) then
        v_resultado := case when r.fase in ('incerto','escrevendo') then 'incerto'
                            when p_observado is null then 'novo' else 'contido' end;
    else
        select coalesce((select k.control_version from public.chatwoot_conversa_controle k
           where k.organizacao_id=p_org and k.conversa_id_local=p_conversa),0) into v_versao;
        v_resultado := case when v_versao=r.versao then 'ok' else 'novo' end;
        if v_resultado='ok' and r.desejado='pending' and r.versao=0 then
            if public.ai_inbox_pendente(p_org,p_conexao,v.id_externo)
               or r.observado_seq<>public.ai_seq_observacao(p_org,p_conexao,v.id_externo) then
                v_resultado:='novo';
            else
                v_resultado := public.iniciar_ai_first_chatwoot(p_org,p_executor,p_conversa,p_evidencia,
                    v.corte,p_global,p_org_versao);
                if v_resultado='ativada' then v_resultado:='ok'; r.versao:=1;
                else v_resultado:='contido'; end if;
            end if;
        end if;
    end if;
    if v_resultado='contido' and r.desejado='pending' and r.versao>0 and p_observado is not null then
        perform public.alterar_controle_atendimento_chatwoot(
            p_org,p_executor,p_conversa,p_token,'exigir_humano',r.versao,'Divergência de status no canal.');
    end if;
    update public.chatwoot_ai_projecao set fase=v_resultado,versao=r.versao,token=null,atualizado_em=now(),
        ate=case when v_resultado in ('incerto','novo') then clock_timestamp()+interval '5 seconds' end
      where organizacao_id=p_org and conversa_id=p_conversa and token=p_token;
    return v_resultado;
end
$$;

revoke all on function public.reivindicar_projecao_ai_first(uuid,uuid,uuid),
    public.iniciar_projecao_ai_first(uuid,uuid,uuid,uuid,uuid),
    public.concluir_projecao_ai_first(uuid,uuid,uuid,uuid,uuid,text,boolean,uuid,bigint,bigint)
    from public,anon,authenticated,service_role;
grant execute on function public.reivindicar_projecao_ai_first(uuid,uuid,uuid),
    public.iniciar_projecao_ai_first(uuid,uuid,uuid,uuid,uuid),
    public.concluir_projecao_ai_first(uuid,uuid,uuid,uuid,uuid,text,boolean,uuid,bigint,bigint) to service_role;

create function public.ai_first_disponivel(p_org uuid,p_conversa uuid)
returns boolean language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.chatwoot_conversations c join public.chatwoot_ai_runtime r
         on r.conexao_id=c.conexao_id and r.organizacao_id=c.organizacao_id
        join public.conexoes_integracao x on x.id=c.conexao_id and x.organizacao_id=c.organizacao_id
        cross join public.estado_autorresposta(p_org) f
        where c.organizacao_id=p_org and c.id_local=p_conversa and x.status='conectado'
          and x.provedor='chatwoot' and r.ativo and r.pronto_ate>now() and f.ativa_global and f.ativa_org
          and not exists (select 1 from public.chatwoot_conversa_controle k
              where k.organizacao_id=p_org and k.conversa_id_local=p_conversa and k.ownership_mode='AI'
                and not exists (select 1 from public.chatwoot_ai_projecao p
                    where p.organizacao_id=p_org and p.conversa_id=p_conversa and p.versao=k.control_version
                      and p.fase='ok' and p.desejado='pending' and p.atualizado_em>now()-interval '2 minutes'
                      and p.observado_seq=public.ai_seq_observacao(p_org,r.conexao_id,c.id_externo)))
    )
$$;

alter function public.alterar_controle_atendimento_chatwoot(uuid,uuid,uuid,uuid,text,bigint,text) rename to alterar_controle_chatwoot_msg009;
revoke all on function public.alterar_controle_chatwoot_msg009(uuid,uuid,uuid,uuid,text,bigint,text)
    from public,anon,authenticated,service_role;
create function public.alterar_controle_atendimento_chatwoot(
    p_organizacao_id uuid,p_ator_id uuid,p_conversa_id_local uuid,p_command_id uuid,
    p_acao text,p_versao_esperada bigint,p_nota text default null
) returns table(resultado text,ownership_mode text,responsavel_id uuid,control_version bigint,
    invalidados integer,em_voo integer,nota_envio_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
    v record;
begin
    if p_acao='devolver' and not exists (select 1 from public.chatwoot_controle_historico h
        where h.organizacao_id=p_organizacao_id and h.command_id=p_command_id) then
        select c.conexao_id,r.executor_id into v from public.chatwoot_conversations c
          left join public.chatwoot_ai_runtime r on r.organizacao_id=c.organizacao_id and r.conexao_id=c.conexao_id
         where c.organizacao_id=p_organizacao_id and c.id_local=p_conversa_id_local;
        perform public.travar_ingresso_ai(v.conexao_id);
        if not coalesce(public.ai_runtime_valido(p_organizacao_id,v.conexao_id,v.executor_id),false) then
            return query select 'automacao_inativa'::text,null::text,null::uuid,null::bigint,0,0,null::uuid;
            return;
        end if;
        perform public.travar_politica_autorresposta(p_organizacao_id);
        perform pg_advisory_xact_lock(hashtextextended(
            'chatwoot_controle:' || p_organizacao_id::text || ':' || p_command_id::text,0));
        perform public.travar_controle_chatwoot(p_organizacao_id,p_conversa_id_local,false);
        if not exists (select 1 from public.estado_autorresposta(p_organizacao_id) where ativa_global and ativa_org)
            or exists (select 1 from public.chatwoot_envios e join public.outbox_eventos o on o.id=e.outbox_evento_id
                where e.organizacao_id=p_organizacao_id and e.conversa_id_local=p_conversa_id_local and not e.privada
                  and (o.status in ('in_flight','unknown') or
                       (e.autorresposta_run_id is null and o.status in ('pending','processing','failed_transient')))) then
            return query select 'automacao_inativa'::text,null::text,null::uuid,null::bigint,0,0,null::uuid;
            return;
        end if;
    end if;
    return query select * from public.alterar_controle_chatwoot_msg009(
        p_organizacao_id,p_ator_id,p_conversa_id_local,p_command_id,p_acao,p_versao_esperada,p_nota);
end
$$;
revoke all on function public.ai_first_disponivel(uuid,uuid),
    public.alterar_controle_atendimento_chatwoot(uuid,uuid,uuid,uuid,text,bigint,text)
    from public,anon,authenticated,service_role;
grant execute on function public.ai_first_disponivel(uuid,uuid),
    public.alterar_controle_atendimento_chatwoot(uuid,uuid,uuid,uuid,text,bigint,text) to service_role;

create function public.escalonar_triagem_ai_first(p_org uuid,p_conexao uuid,p_executor uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
    v record;
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor)
       or not public.executor_autorresposta_ativo(p_org,p_executor) then return null; end if;
    select c.id_local,k.control_version,a.id,s.id as caso,s.ultima_mensagem_em into v
      from public.chatwoot_conversations c
      join public.chatwoot_conversa_controle k on k.organizacao_id=c.organizacao_id and k.conversa_id_local=c.id_local
      join public.sac_cases s on s.organizacao_id=c.organizacao_id and s.conversa_id_local=c.id_local
      cross join lateral (select t.id,t.status,t.resultado from public.ai_runs t
          where t.organizacao_id=p_org and t.caso_id=s.id and t.mensagens_ate=s.ultima_mensagem_em
            and t.tarefa='sac.triagem'
          order by t.sequencia desc limit 1) a
     where c.organizacao_id=p_org and c.conexao_id=p_conexao and k.ownership_mode='AI'
       and s.phase in ('TRIAGE','COLLECTING_INFORMATION')
       and not public.ai_inbox_pendente(p_org,p_conexao,c.id_externo)
       and (a.status='handoff' or (a.status='concluida' and a.resultado->'precisaDeHumano'='true'::jsonb))
       and not exists (select 1 from public.chatwoot_controle_historico h
            where h.organizacao_id=p_org and h.conversa_id_local=c.id_local and h.acao='devolver'
              and h.versao_resultante=k.control_version and h.created_at>=s.ultima_mensagem_em)
     order by s.ultima_mensagem_em,s.id limit 1;
    if not found then return null; end if;
    -- The same CAS protects a concurrent human takeover. Escalating a stale
    -- AI observation is conservative and can never start a new AI send.
    return (select q.resultado from public.alterar_controle_atendimento_chatwoot(
      p_org,p_executor,v.id_local,v.id,'exigir_humano',v.control_version,'Triagem solicitou atendimento humano.') q);
end
$$;
revoke all on function public.escalonar_triagem_ai_first(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.escalonar_triagem_ai_first(uuid,uuid,uuid) to service_role;

-- The lease completion is now the only service role entry that can insert
-- automatic replies. The original checked implementation remains in use.
revoke execute on function public.registrar_autorresposta_chatwoot(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,bigint,bigint),
    public.iniciar_ai_first_chatwoot(uuid,uuid,uuid,uuid,timestamptz,bigint,bigint) from service_role;
