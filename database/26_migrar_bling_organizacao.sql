-- ============================================================================
-- 26_migrar_bling_organizacao.sql
-- Ticket 30: Migrar a conexão Bling para organização
-- Locks atômicos por conexão e migração do ciclo de vida OAuth para organizações
-- ============================================================================

-- 1. Garantir coluna de lock para renovação atômica em conexoes_integracao
alter table public.conexoes_integracao
    add column if not exists refresh_locked_at timestamptz;

-- 2. Lock atômico por Conexão de Integração (Distributed Row-Level Lock)
create or replace function public.acquire_conexao_token_lock(
    p_conexao_id uuid,
    p_timeout_seconds integer default 30
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_locked_at timestamptz;
    v_now timestamptz := pg_catalog.now();
begin
    if p_timeout_seconds < 5 or p_timeout_seconds > 300 then
        raise exception 'Timeout de lock fora do intervalo permitido.' using errcode = '22023';
    end if;

    select refresh_locked_at
    into v_locked_at
    from public.conexoes_integracao
    where id = p_conexao_id
    for update;

    if not found then
        return false;
    end if;

    if v_locked_at is null
       or v_locked_at < v_now - pg_catalog.make_interval(secs => p_timeout_seconds) then
        update public.conexoes_integracao
        set refresh_locked_at = v_now
        where id = p_conexao_id;
        return true;
    end if;

    return false;
end;
$$;

-- 3. Liberação do Lock atômico por Conexão
create or replace function public.release_conexao_token_lock(
    p_conexao_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
    update public.conexoes_integracao
    set refresh_locked_at = null
    where id = p_conexao_id;

    return found;
end;
$$;

-- 4. Função de backfill para migrar credenciais Bling legadas para conexões de organização
create or replace function public.migrar_bling_para_organizacoes()
returns table (
    migrados_conexoes integer,
    migrados_credenciais integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
    v_org_id uuid;
    v_conexao_id uuid;
    v_count_conexoes integer := 0;
    v_count_credenciais integer := 0;
begin
    if not exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'integracoes_bling'
    ) then
        migrados_conexoes := 0;
        migrados_credenciais := 0;
        return next;
        return;
    end if;

    for r in
        execute 'select user_id, client_id, client_secret, access_token, refresh_token, token_expires_at from public.integracoes_bling'
    loop
        -- Identificar a organização do usuário via membros_organizacao
        select organizacao_id into v_org_id
        from public.membros_organizacao
        where user_id = r.user_id
          and papel in ('owner', 'admin')
        order by created_at asc
        limit 1;

        if v_org_id is null then
            select organizacao_id into v_org_id
            from public.membros_organizacao
            where user_id = r.user_id
            order by created_at asc
            limit 1;
        end if;

        if v_org_id is not null then
            -- Inserir ou atualizar conexão
            insert into public.conexoes_integracao (organizacao_id, provedor, nome, status, metadata)
            values (v_org_id, 'bling', 'Principal', case when r.access_token is not null then 'conectado' else 'pendente' end, jsonb_build_object('migrado_de_user_id', r.user_id))
            on conflict (organizacao_id, provedor, nome)
            do update set status = excluded.status;

            select id into v_conexao_id
            from public.conexoes_integracao
            where organizacao_id = v_org_id
              and provedor = 'bling'
              and nome = 'Principal';

            v_count_conexoes := v_count_conexoes + 1;

            -- Inserir credenciais se houver dados
            if v_conexao_id is not null and (r.client_secret is not null or r.access_token is not null) then
                insert into public.credenciais_integracao (conexao_id, organizacao_id, chave_versao, dados_cifrados)
                values (
                    v_conexao_id,
                    v_org_id,
                    'v1',
                    coalesce(r.access_token, r.client_secret, 'migrado')
                )
                on conflict (conexao_id)
                do update set dados_cifrados = excluded.dados_cifrados;

                v_count_credenciais := v_count_credenciais + 1;
            end if;
        end if;
    end loop;

    migrados_conexoes := v_count_conexoes;
    migrados_credenciais := v_count_credenciais;
    return next;
    return;
end;
$$;

-- 5. Concessão de Privilégios Mínimos
revoke all on function public.acquire_conexao_token_lock(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_conexao_token_lock(uuid) from public, anon, authenticated;
revoke all on function public.migrar_bling_para_organizacoes() from public, anon, authenticated;

grant execute on function public.acquire_conexao_token_lock(uuid, integer) to postgres, service_role;
grant execute on function public.release_conexao_token_lock(uuid) to postgres, service_role;
grant execute on function public.migrar_bling_para_organizacoes() to postgres, service_role;
