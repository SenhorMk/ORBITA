-- Check the named RPC contract and grants on PostgreSQL, with no live gateway.
begin;
do $$
declare
    r record;
    endpoint regprocedure;
    args text[];
begin
    for r in select * from (values
        ('renovar_worker_ai_first(uuid,uuid,uuid,boolean)','p_org,p_conexao,p_executor,p_pronto'),
        ('reivindicar_projecao_ai_first(uuid,uuid,uuid)','p_org,p_conexao,p_executor'),
        ('iniciar_projecao_ai_first(uuid,uuid,uuid,uuid,uuid)','p_org,p_conexao,p_executor,p_conversa,p_token'),
        ('concluir_projecao_ai_first(uuid,uuid,uuid,uuid,uuid,text,boolean,uuid,bigint,bigint)',
         'p_org,p_conexao,p_executor,p_conversa,p_token,p_observado,p_sem_responsavel,p_evidencia,p_global,p_org_versao'),
        ('escalonar_triagem_ai_first(uuid,uuid,uuid)','p_org,p_conexao,p_executor'),
        ('reivindicar_geracao_ai_first(uuid,uuid,uuid)','p_org,p_conexao,p_executor'),
        ('concluir_geracao_ai_first(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,bigint,bigint,text)',
         'p_org,p_conexao,p_executor,p_token,p_caso,p_conversa,p_run,p_versao,p_global,p_org_versao,p_texto'),
        ('ai_first_disponivel(uuid,uuid)','p_org,p_conversa'),
        ('iniciar_envio_chatwoot(uuid,text,bigint)','p_evento_id,p_worker_id,p_fencing_token'),
        ('alterar_controle_atendimento_chatwoot(uuid,uuid,uuid,uuid,text,bigint,text)',
          'p_organizacao_id,p_ator_id,p_conversa_id_local,p_command_id,p_acao,p_versao_esperada,p_nota')
      ) as expected(signature,names)
    loop
        endpoint := ('public.' || r.signature)::regprocedure;
        select proargnames[1:pronargs] into args from pg_proc where oid=endpoint;
        if args is distinct from string_to_array(r.names,',')
           or not has_function_privilege('service_role',endpoint,'execute')
           or has_function_privilege('anon',endpoint,'execute')
           or has_function_privilege('authenticated',endpoint,'execute') then
            raise exception 'RPC contract/grants diverged: %',r.signature;
        end if;
    end loop;
    if has_function_privilege('service_role','public.iniciar_envio_chatwoot_msg022(uuid,text,bigint)','execute')
       or has_function_privilege('service_role',
           'public.alterar_controle_chatwoot_msg009(uuid,uuid,uuid,uuid,text,bigint,text)','execute')
       or has_table_privilege('service_role','public.chatwoot_ai_runtime','update') then
        raise exception 'Worker can bypass one of its fences';
    end if;
end
$$;
set local role service_role;
select public.renovar_worker_ai_first(
    p_org=>'00000000-0000-4000-8000-000000000001',
    p_conexao=>'00000000-0000-4000-8000-000000000002',
    p_executor=>'00000000-0000-4000-8000-000000000003',p_pronto=>false
) as unconfigured_runtime_returns_false;
rollback;
