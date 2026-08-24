-- Ticket 05: close mutable RPC grants and bind user actions to auth.uid().

-- Existing functions may still inherit EXECUTE from PUBLIC. Remove that ambient
-- capability before applying the explicit role allowlist below.
revoke execute on all functions in schema public from public, anon;

-- Provider callbacks, workers and audit writers are server-side infrastructure.
do $migration$
declare
    v_signature text;
    v_function regprocedure;
begin
    foreach v_signature in array array[
        'public.registrar_evento_inbox_bling(uuid,uuid,uuid,text,text,jsonb)',
        'public.concluir_evento_inbox_bling(uuid,text,jsonb,text)',
        'public.preparar_replay_evento_inbox_bling(uuid)',
        'public.registrar_evento_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,jsonb)',
        'public.concluir_evento_inbox_chatwoot(uuid,text,jsonb,text)',
        'public.preparar_replay_evento_inbox_chatwoot(uuid)',
        'public.registrar_job_sync(uuid,uuid)',
        'public.registrar_evento_outbox(uuid,uuid,uuid,text,text,text,jsonb,integer)',
        'public.atualizar_saude_conexao(uuid,text,text)',
        'public.registrar_evento_auditoria(uuid,uuid,text,text,text,text,text,text,jsonb)'
    ] loop
        v_function := to_regprocedure(v_signature);
        if v_function is not null then
            execute format('revoke execute on function %s from authenticated', v_function);
        end if;
    end loop;
end;
$migration$;

-- This compatibility argument is deliberately ignored for browser callers.
-- Authorization always follows the verified JWT subject inside PostgreSQL.
create or replace function public.usuario_tem_papel_na_organizacao(
    p_org_id uuid,
    p_papel text,
    p_user_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.membros_organizacao m
        where m.organizacao_id = p_org_id
          and m.user_id = auth.uid()
          and case
                when p_papel = 'owner' then m.papel = 'owner'
                when p_papel = 'admin' then m.papel in ('owner', 'admin')
                else false
              end
    );
$$;

revoke all on function public.usuario_tem_papel_na_organizacao(uuid, text, uuid) from public, anon;
grant execute on function public.usuario_tem_papel_na_organizacao(uuid, text, uuid) to authenticated, service_role;

create or replace function public.agendar_encerramento_organizacao(
    p_org_id uuid,
    p_motivo text,
    p_dias_retencao integer default 30,
    p_autor_id uuid default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor_id uuid := auth.uid();
    v_exclusao_em timestamptz;
    v_server_call boolean := coalesce(auth.role(), '') = 'service_role';
begin
    if not v_server_call and not public.usuario_tem_papel_na_organizacao(p_org_id, 'owner', null) then
        raise exception 'Apenas o Owner pode solicitar o encerramento da organizacao' using errcode = '42501';
    end if;
    if v_server_call then
        v_actor_id := p_autor_id;
    end if;
    if p_dias_retencao is null or p_dias_retencao not between 1 and 365 then
        raise exception 'Periodo de retencao deve estar entre 1 e 365 dias' using errcode = '22023';
    end if;

    v_exclusao_em := now() + make_interval(days => p_dias_retencao);
    update public.organizacoes
    set status = 'pending_deletion',
        exclusao_agendada_para = v_exclusao_em,
        updated_at = now()
    where id = p_org_id;
    if not found then
        raise exception 'Organizacao nao encontrada' using errcode = 'P0002';
    end if;

    insert into public.historico_ciclo_vida_organizacao (
        organizacao_id, acao, motivo, autor_user_id, metadata
    ) values (
        p_org_id, 'agendamento_encerramento', p_motivo, v_actor_id,
        jsonb_build_object('exclusao_agendada_para', v_exclusao_em, 'dias_retencao', p_dias_retencao)
    );
    return v_exclusao_em;
end;
$$;

create or replace function public.cancelar_agendamento_encerramento(
    p_org_id uuid,
    p_autor_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor_id uuid := auth.uid();
    v_server_call boolean := coalesce(auth.role(), '') = 'service_role';
begin
    if not v_server_call and not public.usuario_tem_papel_na_organizacao(p_org_id, 'owner', null) then
        raise exception 'Apenas o Owner pode cancelar o encerramento da organizacao' using errcode = '42501';
    end if;
    if v_server_call then
        v_actor_id := p_autor_id;
    end if;

    update public.organizacoes
    set status = 'active', exclusao_agendada_para = null, updated_at = now()
    where id = p_org_id and status = 'pending_deletion';
    if not found then
        raise exception 'Organizacao sem encerramento agendado' using errcode = 'P0002';
    end if;

    insert into public.historico_ciclo_vida_organizacao (
        organizacao_id, acao, motivo, autor_user_id
    ) values (
        p_org_id, 'cancelamento_encerramento',
        'Cancelamento solicitado pelo Owner', v_actor_id
    );
end;
$$;

revoke all on function public.agendar_encerramento_organizacao(uuid, text, integer, uuid) from public, anon;
revoke all on function public.cancelar_agendamento_encerramento(uuid, uuid) from public, anon;
grant execute on function public.agendar_encerramento_organizacao(uuid, text, integer, uuid) to authenticated, service_role;
grant execute on function public.cancelar_agendamento_encerramento(uuid, uuid) to authenticated, service_role;
