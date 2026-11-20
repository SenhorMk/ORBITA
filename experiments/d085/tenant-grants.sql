-- Native PostgreSQL supplemental evidence. The transaction leaves no fixtures.
begin;
insert into auth.users(id,email) values ('d0850000-0000-4000-8000-0000000000a1','executor-d085@orbita.test');
insert into public.organizacoes(id,nome,slug,status) values
 ('d0850000-0000-4000-8000-00000000000a','A sintética','d085-a','active'),
 ('d0850000-0000-4000-8000-00000000000b','B sintética','d085-b','active');
insert into public.membros_organizacao(organizacao_id,user_id,papel) values
 ('d0850000-0000-4000-8000-00000000000a','d0850000-0000-4000-8000-0000000000a1','owner');
insert into public.sac_executores_autorresposta values
 ('d0850000-0000-4000-8000-00000000000a','d0850000-0000-4000-8000-0000000000a1');
insert into public.conexoes_integracao(id,organizacao_id,provedor,nome,status) values
 ('d0850000-0000-4000-8000-0000000000c1','d0850000-0000-4000-8000-00000000000a','chatwoot','A','conectado');
insert into public.chatwoot_ai_runtime(conexao_id,organizacao_id,executor_id,inbox_id,corte,ativo) values
 ('d0850000-0000-4000-8000-0000000000c1','d0850000-0000-4000-8000-00000000000a',
  'd0850000-0000-4000-8000-0000000000a1',1,now(),true);

set local role service_role;
do $$
declare
    org_a constant uuid := 'd0850000-0000-4000-8000-00000000000a';
    org_b constant uuid := 'd0850000-0000-4000-8000-00000000000b';
    executor constant uuid := 'd0850000-0000-4000-8000-0000000000a1';
    conexao constant uuid := 'd0850000-0000-4000-8000-0000000000c1';
begin
    if public.renovar_worker_ai_first(org_a,conexao,executor,true) is distinct from true then
        raise exception 'O executor cadastrado não renovou a própria conexão';
    end if;
    if public.renovar_worker_ai_first(org_b,conexao,executor,true) is distinct from false
       or public.renovar_worker_ai_first(org_b,conexao,executor,false) is distinct from false
       or public.reivindicar_projecao_ai_first(org_b,conexao,executor) is not null
       or public.reivindicar_geracao_ai_first(org_b,conexao,executor) is not null then
        raise exception 'Escopo B alcançou configuração ou trabalho de A';
    end if;
    begin
        perform 1 from public.chatwoot_ai_runtime;
        raise exception 'Leitura direta do runtime deveria ser negada';
    exception when insufficient_privilege then null;
    end;
    raise notice 'Service role: RPC válida em A, quatro tentativas cruzadas e leitura de tabela negadas.';
end
$$;
set local role authenticated;
do $$
begin
    begin
        perform public.renovar_worker_ai_first('d0850000-0000-4000-8000-00000000000a',
            'd0850000-0000-4000-8000-0000000000c1','d0850000-0000-4000-8000-0000000000a1',false);
        raise exception 'A chamada pelo papel authenticated deveria ser negada';
    exception when insufficient_privilege then null;
    end;
    raise notice 'Authenticated: execução da RPC de heartbeat negada.';
end
$$;
rollback;
