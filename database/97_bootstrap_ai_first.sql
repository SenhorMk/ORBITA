-- Candidate migration. Apply after order 99 only in the isolated D08.2 lab.
-- The status readback is an attestation from the trusted channel adapter.
alter table public.chatwoot_controle_historico
    drop constraint ck_chatwoot_controle_historico_acao,
    add constraint ck_chatwoot_controle_historico_acao
    check (acao in ('assumir', 'devolver', 'exigir_humano', 'assumir_por_envio', 'iniciar_ia'));

create function public.iniciar_ai_first_chatwoot(
    p_org uuid, p_executor uuid, p_conversa uuid, p_evento_criacao uuid,
    p_corte timestamptz, p_global bigint, p_org_versao bigint
) returns text
language plpgsql security definer set search_path = '' as $$
declare
    v_politica record;
    v_controle public.chatwoot_conversa_controle;
    v_criacao timestamptz;
begin
    if p_org is null or p_executor is null or p_conversa is null
       or p_evento_criacao is null or p_corte is null or not isfinite(p_corte) then
        return 'evidencia_insuficiente';
    end if;

    perform public.travar_politica_autorresposta(p_org);
    if not public.executor_autorresposta_ativo(p_org, p_executor) then
        return 'executor_nao_autorizado';
    end if;
    select * into strict v_politica from public.estado_autorresposta(p_org);
    if not (v_politica.ativa_global and v_politica.ativa_org)
       or (v_politica.versao_global, v_politica.versao_org) is distinct from (p_global, p_org_versao) then
        return 'politica_obsoleta';
    end if;

    -- The webhook is written by the existing signature/account boundary.
    -- An event id supplied for another org, connection or inbox cannot qualify.
    select case when e.payload #>> '{conversation,created_at}' ~ '^[0-9]{10}([.][0-9]{1,6})?$'
                then to_timestamp((e.payload #>> '{conversation,created_at}')::double precision) end
      into v_criacao
      from public.inbox_eventos_chatwoot e
      join public.chatwoot_conversations c on c.organizacao_id = e.organizacao_id and c.conexao_id = e.conexao_id
      join public.chatwoot_inboxes i on i.organizacao_id = c.organizacao_id and i.conexao_id = c.conexao_id
           and i.inbox_id = c.inbox_id
      join public.conexoes_integracao x on x.id = c.conexao_id and x.organizacao_id = c.organizacao_id
     where e.id = p_evento_criacao and e.organizacao_id = p_org and c.id_local = p_conversa
       and x.provedor = 'chatwoot' and x.status = 'conectado'
       and e.inbox_id = c.inbox_id and e.payload #>> '{account,id}' = i.account_id::text
       and e.event_type = 'conversation_created'
       and e.payload #>> '{conversation,id}' = c.id_externo
       and e.payload #>> '{conversation,inbox_id}' = c.inbox_id::text
       and e.payload #> '{conversation,assignee_id}' = 'null'::jsonb
       and e.created_at >= p_corte;
    if v_criacao is null or v_criacao < p_corte
       or v_criacao not between now() - interval '10 minutes' and now() + interval '5 seconds' then
        return 'evidencia_insuficiente';
    end if;

    v_controle := public.travar_controle_chatwoot(p_org, p_conversa, false);
    if exists (select 1 from public.chatwoot_controle_historico
        where organizacao_id = p_org and conversa_id_local = p_conversa
          and command_id = p_evento_criacao and acao = 'iniciar_ia') then
        return 'existente';
    end if;
    if v_controle.ownership_mode <> 'HUMAN_REQUIRED' or v_controle.control_version <> 0 then
        return 'posse_alterada';
    end if;

    perform 1 from public.sac_cases s
      join public.chatwoot_messages m on m.organizacao_id = s.organizacao_id
       and m.id_local = s.mensagem_origem_id_local and m.conversa_id_local = s.conversa_id_local
     where s.organizacao_id = p_org and s.conversa_id_local = p_conversa and s.phase in ('TRIAGE', 'COLLECTING_INFORMATION')
       and m.message_type = 'incoming' and m.sender_type = 'contact'
       and m.created_at >= date_trunc('second', v_criacao)
     for share of s;
    if not found or exists (select 1 from public.chatwoot_messages
        where organizacao_id = p_org and conversa_id_local = p_conversa and message_type = 'outgoing') then
        return 'evidencia_insuficiente';
    end if;

    update public.chatwoot_conversa_controle set ownership_mode = 'AI', control_version = 1, updated_at = now()
      where organizacao_id = p_org and conversa_id_local = p_conversa;
    insert into public.chatwoot_controle_historico
        (organizacao_id, conversa_id_local, command_id, acao, comando_digest,
         modo_anterior, modo_novo, versao_resultante, ator_id)
    values (p_org, p_conversa, p_evento_criacao, 'iniciar_ia',
        encode(sha256(convert_to(p_evento_criacao::text, 'UTF8')), 'hex'),
        'HUMAN_REQUIRED', 'AI', 1, p_executor);
    return 'ativada';
end;
$$;

revoke all on function public.iniciar_ai_first_chatwoot(uuid,uuid,uuid,uuid,timestamptz,bigint,bigint)
    from public, anon, authenticated, service_role;
grant execute on function public.iniciar_ai_first_chatwoot(uuid,uuid,uuid,uuid,timestamptz,bigint,bigint)
    to service_role;
