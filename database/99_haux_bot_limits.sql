-- Operational limits for the existing AI-first worker. No activation on migration.
set local lock_timeout = '5s';
alter table public.chatwoot_ai_runtime add column limite_geracoes_dia integer not null default 0
  check (limite_geracoes_dia between 0 and 100);
create table public.chatwoot_ai_consumo (
  organizacao_id uuid not null references public.organizacoes(id),
  conexao_id uuid not null references public.conexoes_integracao(id),
  token uuid primary key,
  criada_em timestamptz not null default clock_timestamp()
);
create index ix_chatwoot_ai_consumo_dia on public.chatwoot_ai_consumo(organizacao_id,conexao_id,criada_em);
alter table public.chatwoot_ai_consumo enable row level security;
revoke all on public.chatwoot_ai_consumo from public,anon,authenticated,service_role;

alter function public.reivindicar_geracao_ai_first(uuid,uuid,uuid) rename to reivindicar_geracao_ai_first_sem_cota;
revoke all on function public.reivindicar_geracao_ai_first_sem_cota(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.reivindicar_geracao_ai_first(p_org uuid,p_conexao uuid,p_executor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_limite integer; v_usadas bigint;
begin
  perform public.travar_ingresso_ai(p_conexao);
  select limite_geracoes_dia into v_limite from public.chatwoot_ai_runtime
    where organizacao_id=p_org and conexao_id=p_conexao and executor_id=p_executor for share;
  v := public.reivindicar_geracao_ai_first_sem_cota(p_org,p_conexao,p_executor);
  if v is null then return null; end if;
  select count(*) into v_usadas from public.chatwoot_ai_consumo
    where organizacao_id=p_org and conexao_id=p_conexao
      and criada_em >= date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC';
  if v_limite is null or v_usadas>=v_limite then
    perform public.concluir_geracao_ai_first(p_org,p_conexao,p_executor,(v->>'token')::uuid,
      (v->>'caso')::uuid,(v->>'conversa')::uuid,(v->>'run')::uuid,(v->>'versao')::bigint,
      (v->>'versao_global')::bigint,(v->>'versao_org')::bigint,null);
    return null;
  end if;
  -- Reserve before the provider call, including crashes and ambiguous API failures.
  insert into public.chatwoot_ai_consumo(organizacao_id,conexao_id,token) values(p_org,p_conexao,(v->>'token')::uuid);
  return v;
end $$;
revoke all on function public.reivindicar_geracao_ai_first(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.reivindicar_geracao_ai_first(uuid,uuid,uuid) to service_role;

create function public.reivindicar_triagens_ai_first(p_org uuid,p_conexao uuid,p_executor uuid,
  p_worker_id text,p_limite integer default 1,p_lease_ttl_sec integer default 120)
returns table(evento_id uuid,organizacao_id uuid,caso_id uuid,mensagens_ate timestamptz,
  attempts integer,correlation_id text,fencing_token bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 200 or p_limite is null or p_limite not between 1 and 5
    or p_lease_ttl_sec is null or p_lease_ttl_sec not between 30 and 600 then raise exception 'Configuração inválida' using errcode='22023'; end if;
  perform public.travar_ingresso_ai(p_conexao);
  if not public.ai_runtime_valido(p_org,p_conexao,p_executor) or not public.executor_autorresposta_ativo(p_org,p_executor)
    or not exists(select 1 from public.estado_autorresposta(p_org) where ativa_global and ativa_org) then return; end if;
  return query with lote as (
    select o.id from public.outbox_eventos o
    join public.sac_cases s on s.organizacao_id=o.organizacao_id and s.id=(o.payload->>'caso_id')::uuid
    join public.chatwoot_conversations c on c.organizacao_id=s.organizacao_id and c.id_local=s.conversa_id_local
    join public.chatwoot_ai_runtime r on r.organizacao_id=c.organizacao_id and r.conexao_id=c.conexao_id and r.inbox_id=c.inbox_id
    join public.chatwoot_conversa_controle k on k.organizacao_id=c.organizacao_id and k.conversa_id_local=c.id_local
    where o.organizacao_id=p_org and c.conexao_id=p_conexao and k.ownership_mode='AI'
      and s.ultima_mensagem_em>=r.corte and o.destination='interno' and o.event_type='sac.triagem'
      and o.status in ('pending','failed_transient') and o.next_retry_at<=clock_timestamp()
    order by o.next_retry_at,o.id limit p_limite for update of o skip locked
  ) update public.outbox_eventos o set status='processing',lease_owner=p_worker_id,
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_ttl_sec),updated_at=clock_timestamp()
    from lote where o.id=lote.id
    returning o.id,o.organizacao_id,(o.payload->>'caso_id')::uuid,(o.payload->>'mensagens_ate')::timestamptz,
      o.attempts,o.correlation_id,o.fencing_token;
end $$;
revoke all on function public.reivindicar_triagens_ai_first(uuid,uuid,uuid,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.reivindicar_triagens_ai_first(uuid,uuid,uuid,text,integer,integer) to service_role;

-- Stop only; reactivation requires a separate, explicitly approved operation.
create function public.desligar_runtime_ai_first(p_org uuid,p_conexao uuid,p_executor uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.travar_ingresso_ai(p_conexao);
  update public.chatwoot_ai_runtime set ativo=false,pronto_ate='-infinity'
    where organizacao_id=p_org and conexao_id=p_conexao and executor_id=p_executor;
  return found;
end $$;
revoke all on function public.desligar_runtime_ai_first(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.desligar_runtime_ai_first(uuid,uuid,uuid) to service_role;
