-- PROPOSTA: não aplicar sem aprovação explícita do SQL e dos gates.
-- Somente staging etqjqeqqbjrzyyxodntv. Nenhuma ativação ou merge.
-- Runtime existente preservado; não insere configuração para WhatsApp.
-- O executor de migrations deve abrir a transação e gravar o ledger antes do commit.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT public.travar_ingresso_ai('bc55e20a-dd17-416c-9343-c511e3cd0b1b'::uuid);

-- Antes da expansão, uma conexão possui exatamente um runtime: isso permite
-- atribuir o consumo histórico à inbox original sem inferir por mensagem.
ALTER TABLE public.chatwoot_ai_consumo ADD COLUMN inbox_id integer;
UPDATE public.chatwoot_ai_consumo s SET inbox_id=r.inbox_id
  FROM public.chatwoot_ai_runtime r
 WHERE r.organizacao_id=s.organizacao_id AND r.conexao_id=s.conexao_id;
ALTER TABLE public.chatwoot_ai_consumo ALTER COLUMN inbox_id SET NOT NULL;
ALTER TABLE public.chatwoot_ai_consumo ADD CONSTRAINT ck_ai_consumo_inbox CHECK (inbox_id>0);
CREATE INDEX ix_chatwoot_ai_consumo_inbox_dia
 ON public.chatwoot_ai_consumo(organizacao_id,conexao_id,inbox_id,criada_em);

ALTER TABLE public.chatwoot_ai_runtime DROP CONSTRAINT chatwoot_ai_runtime_pkey;
ALTER TABLE public.chatwoot_ai_runtime ADD PRIMARY KEY (conexao_id,inbox_id);
-- RLS, revogações, flags, corte, controles e quotas existentes permanecem.

CREATE FUNCTION public.renovar_worker_ai_first_inbox(
 p_org uuid,p_conexao uuid,p_executor uuid,p_inbox integer,p_pronto boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $body$
BEGIN
 PERFORM public.travar_ingresso_ai(p_conexao);
 IF p_pronto AND NOT public.executor_autorresposta_ativo(p_org,p_executor) THEN RETURN false; END IF;
 UPDATE public.chatwoot_ai_runtime r
 SET pronto_ate=CASE WHEN p_pronto THEN clock_timestamp()+interval '30 seconds' ELSE '-infinity' END
 WHERE r.organizacao_id=p_org AND r.conexao_id=p_conexao AND r.executor_id=p_executor
   AND r.inbox_id=p_inbox AND r.ativo;
 RETURN found;
END $body$;
REVOKE ALL ON FUNCTION public.renovar_worker_ai_first_inbox(uuid,uuid,uuid,integer,boolean)
 FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.renovar_worker_ai_first_inbox(uuid,uuid,uuid,integer,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.ai_contexto_worker(p_org uuid, p_conexao uuid, p_executor uuid)
 RETURNS TABLE(caso uuid, conversa uuid, ate timestamp with time zone, run uuid, versao bigint, versao_global bigint, versao_org bigint, intencao text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
    select s.id,c.id_local,s.ultima_mensagem_em,r.id,k.control_version,
           flags.versao_global,flags.versao_org,r.resultado->>'intencao'
    from public.chatwoot_conversations c
    join public.chatwoot_ai_runtime t on t.organizacao_id=c.organizacao_id and t.conexao_id=c.conexao_id
      and t.inbox_id=c.inbox_id and t.ativo and t.pronto_ate>clock_timestamp() and t.executor_id=p_executor
    join public.chatwoot_conversa_controle k on k.organizacao_id=c.organizacao_id and k.conversa_id_local=c.id_local
    join public.chatwoot_ai_projecao p on p.organizacao_id=c.organizacao_id and p.conversa_id=c.id_local
    join public.sac_cases s on s.organizacao_id=c.organizacao_id and s.conversa_id_local=c.id_local
    cross join lateral public.estado_autorresposta(p_org) flags
    cross join lateral (select a.id,a.resultado from public.ai_runs a
        where a.organizacao_id=s.organizacao_id and a.caso_id=s.id and a.mensagens_ate=s.ultima_mensagem_em
          and a.tarefa='sac.triagem'
        order by a.sequencia desc limit 1) r
    where c.organizacao_id=p_org and c.conexao_id=p_conexao
      and (t.conversa_teste_externa is null or t.conversa_teste_externa=c.id_externo)
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
$function$;

CREATE OR REPLACE FUNCTION public.reivindicar_projecao_ai_first(p_org uuid, p_conexao uuid, p_executor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        and t.inbox_id=c.inbox_id and t.ativo and t.pronto_ate>clock_timestamp() and t.executor_id=p_executor
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
        and (t.conversa_teste_externa is null or t.conversa_teste_externa=c.id_externo)
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
$function$;

CREATE OR REPLACE FUNCTION public.escalonar_triagem_ai_first(p_org uuid, p_conexao uuid, p_executor uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    v record;
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor)
       or not public.executor_autorresposta_ativo(p_org,p_executor) then return null; end if;
    select c.id_local,k.control_version,a.id,s.id as caso,s.ultima_mensagem_em into v
      from public.chatwoot_conversations c
      join public.chatwoot_ai_runtime t on t.organizacao_id=c.organizacao_id and t.conexao_id=c.conexao_id
        and t.inbox_id=c.inbox_id and t.ativo and t.pronto_ate>clock_timestamp() and t.executor_id=p_executor
      join public.chatwoot_conversa_controle k on k.organizacao_id=c.organizacao_id and k.conversa_id_local=c.id_local
      join public.sac_cases s on s.organizacao_id=c.organizacao_id and s.conversa_id_local=c.id_local
      cross join lateral (select t.id,t.status,t.resultado from public.ai_runs t
          where t.organizacao_id=p_org and t.caso_id=s.id and t.mensagens_ate=s.ultima_mensagem_em
            and t.tarefa='sac.triagem'
          order by t.sequencia desc limit 1) a
     where c.organizacao_id=p_org and c.conexao_id=p_conexao and k.ownership_mode='AI'
       and (t.conversa_teste_externa is null or t.conversa_teste_externa=c.id_externo)
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
$function$;

CREATE OR REPLACE FUNCTION public.reivindicar_triagens_ai_first(p_org uuid, p_conexao uuid, p_executor uuid, p_worker_id text, p_limite integer DEFAULT 1, p_lease_ttl_sec integer DEFAULT 120)
 RETURNS TABLE(evento_id uuid, organizacao_id uuid, caso_id uuid, mensagens_ate timestamp with time zone, attempts integer, correlation_id text, fencing_token bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    join public.chatwoot_ai_runtime r on r.organizacao_id=c.organizacao_id and r.conexao_id=c.conexao_id and r.inbox_id=c.inbox_id and r.ativo and r.pronto_ate>clock_timestamp() and r.executor_id=p_executor
    join public.chatwoot_conversa_controle k on k.organizacao_id=c.organizacao_id and k.conversa_id_local=c.id_local
    where o.organizacao_id=p_org and c.conexao_id=p_conexao and k.ownership_mode='AI'
      and (r.conversa_teste_externa is null or r.conversa_teste_externa=c.id_externo)
      and s.ultima_mensagem_em>=r.corte and o.destination='interno' and o.event_type='sac.triagem'
      and o.status in ('pending','failed_transient') and o.next_retry_at<=clock_timestamp()
    order by o.next_retry_at,o.id limit p_limite for update of o skip locked
  ) update public.outbox_eventos o set status='processing',lease_owner=p_worker_id,
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_ttl_sec),updated_at=clock_timestamp()
    from lote where o.id=lote.id
    returning o.id,o.organizacao_id,(o.payload->>'caso_id')::uuid,(o.payload->>'mensagens_ate')::timestamptz,
      o.attempts,o.correlation_id,o.fencing_token;
end $function$;

CREATE OR REPLACE FUNCTION public.iniciar_projecao_ai_first(p_org uuid, p_conexao uuid, p_executor uuid, p_conversa uuid, p_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor) then return false; end if;
    update public.chatwoot_ai_projecao p set fase='escrevendo'
      from public.chatwoot_conversations c
     where p.organizacao_id=p_org and p.conversa_id=p_conversa and p.token=p_token and p.fase='lendo' and not p.somente_leitura
       and p.ate>clock_timestamp() and c.organizacao_id=p_org and c.id_local=p_conversa and c.conexao_id=p_conexao
       and exists (select 1 from public.chatwoot_ai_runtime t where t.organizacao_id=p_org and t.conexao_id=p_conexao and t.inbox_id=c.inbox_id and t.ativo and t.pronto_ate>clock_timestamp() and t.executor_id=p_executor
           and (t.conversa_teste_externa is null or t.conversa_teste_externa=c.id_externo))
       and p.versao=coalesce((select k.control_version from public.chatwoot_conversa_controle k
           where k.organizacao_id=p_org and k.conversa_id_local=p_conversa),0)
       and not public.ai_inbox_pendente(p_org,p_conexao,c.id_externo)
       and p.observado_seq=public.ai_seq_observacao(p_org,p_conexao,c.id_externo)
       and (p.desejado='open' or exists (select 1 from public.estado_autorresposta(p_org) where ativa_global and ativa_org));
    return found;
end
$function$;

CREATE OR REPLACE FUNCTION public.concluir_projecao_ai_first(p_org uuid, p_conexao uuid, p_executor uuid, p_conversa uuid, p_token uuid, p_observado text, p_sem_responsavel boolean, p_evidencia uuid, p_global bigint, p_org_versao bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    r public.chatwoot_ai_projecao;
    v record;
    v_versao bigint;
    v_resultado text;
begin
    perform public.travar_ingresso_ai(p_conexao);
    if not public.ai_runtime_valido(p_org,p_conexao,p_executor) then return 'indisponivel'; end if;
    select c.id_externo,t.corte into v from public.chatwoot_conversations c
      join public.chatwoot_ai_runtime t on t.organizacao_id=c.organizacao_id and t.conexao_id=c.conexao_id and t.inbox_id=c.inbox_id and t.ativo and t.pronto_ate>clock_timestamp() and t.executor_id=p_executor
     where c.organizacao_id=p_org and c.id_local=p_conversa and c.conexao_id=p_conexao
       and (t.conversa_teste_externa is null or t.conversa_teste_externa=c.id_externo);
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
$function$;

CREATE OR REPLACE FUNCTION public.iniciar_envio_chatwoot(p_evento_id uuid, p_worker_id text, p_fencing_token bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    v record;
begin
    select e.*, c.id_externo, c.inbox_id as inbox_escopo into v from public.chatwoot_envios e
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
       or not exists (select 1 from public.chatwoot_ai_runtime r where r.conexao_id=v.conexao_id
           and r.organizacao_id=v.organizacao_id and r.inbox_id=v.inbox_escopo and r.ativo and r.pronto_ate>clock_timestamp() and r.executor_id=v.ator_id
           and (r.conversa_teste_externa is null or r.conversa_teste_externa=v.id_externo))
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
$function$;

CREATE OR REPLACE FUNCTION public.alterar_controle_atendimento_chatwoot(p_organizacao_id uuid, p_ator_id uuid, p_conversa_id_local uuid, p_command_id uuid, p_acao text, p_versao_esperada bigint, p_nota text DEFAULT NULL::text)
 RETURNS TABLE(resultado text, ownership_mode text, responsavel_id uuid, control_version bigint, invalidados integer, em_voo integer, nota_envio_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    v record;
begin
    if p_acao='devolver' and not exists (select 1 from public.chatwoot_controle_historico h
        where h.organizacao_id=p_organizacao_id and h.command_id=p_command_id) then
        select c.conexao_id,r.executor_id,r.ativo,r.pronto_ate into v from public.chatwoot_conversations c
          left join public.chatwoot_ai_runtime r on r.organizacao_id=c.organizacao_id and r.conexao_id=c.conexao_id
            and r.inbox_id=c.inbox_id
         where c.organizacao_id=p_organizacao_id and c.id_local=p_conversa_id_local;
        perform public.travar_ingresso_ai(v.conexao_id);
        if not coalesce(public.ai_runtime_valido(p_organizacao_id,v.conexao_id,v.executor_id),false)
           or not coalesce(v.ativo and v.pronto_ate>clock_timestamp(),false) then
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
$function$;

CREATE OR REPLACE FUNCTION public.reivindicar_geracao_ai_first(p_org uuid, p_conexao uuid, p_executor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v jsonb; v_limite integer; v_usadas bigint; v_inbox integer;
begin
  perform public.travar_ingresso_ai(p_conexao);
  v := public.reivindicar_geracao_ai_first_sem_cota(p_org,p_conexao,p_executor);
  if v is null then return null; end if;
  select c.inbox_id,r.limite_geracoes_dia into v_inbox,v_limite
    from public.chatwoot_conversations c join public.chatwoot_ai_runtime r
      on r.organizacao_id=c.organizacao_id and r.conexao_id=c.conexao_id and r.inbox_id=c.inbox_id
    where c.organizacao_id=p_org and c.conexao_id=p_conexao and c.id_local=(v->>'conversa')::uuid
      and r.executor_id=p_executor and r.ativo and r.pronto_ate>clock_timestamp() for share of r;
  select count(*) into v_usadas from public.chatwoot_ai_consumo
    where organizacao_id=p_org and conexao_id=p_conexao and inbox_id=v_inbox
      and criada_em >= date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC';
  if v_limite is null or v_usadas>=v_limite then
    perform public.concluir_geracao_ai_first(p_org,p_conexao,p_executor,(v->>'token')::uuid,
      (v->>'caso')::uuid,(v->>'conversa')::uuid,(v->>'run')::uuid,(v->>'versao')::bigint,
      (v->>'versao_global')::bigint,(v->>'versao_org')::bigint,null);
    return null;
  end if;
  -- Reserve before the provider call, including crashes and ambiguous API failures.
  insert into public.chatwoot_ai_consumo(organizacao_id,conexao_id,inbox_id,token) values(p_org,p_conexao,v_inbox,(v->>'token')::uuid);
  return v;
end $function$;

-- CREATE OR REPLACE mantém as ACLs das nove funções existentes.
-- Nenhuma inserção de runtime/inbox, liberação de clientes ou mudança no ERP.
-- Commit somente pelo executor, após validação e registro do hash no ledger.
