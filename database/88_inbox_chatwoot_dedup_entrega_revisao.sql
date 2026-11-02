-- 88_inbox_chatwoot_dedup_entrega_revisao.sql
-- Forward-only. MSG-005: o webhook do Chatwoot persiste a entrega e o evento
-- minimizado antes do ACK, com dedup por entrega e por revisão.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia canônica 01-87):
--   - `registrar_evento_inbox_chatwoot` faz `select ... for update` e depois
--     `insert`. Duas entregas iguais e simultâneas não acham linha nenhuma no
--     `select`; a segunda estoura `23505` no `insert` e o webhook responde 500.
--   - Não há registro de entrega. O `X-Chatwoot-Delivery` nem é lido, então
--     uma entrega repetida só é reconhecida pela chave semântica.
--   - A chave semântica (app) é só o id remoto: `message_updated` da mesma
--     mensagem e a segunda resolução da mesma conversa viram "duplicata" e
--     são descartadas com 200.
--   - A função não confere a conexão: aceita um evento para uma conexão de
--     outra organização, de outro provedor ou desligada.
--
-- O QUE MUDA:
--   1. `inbox_entregas_chatwoot`: uma linha por entrega identificada
--      (organização + conexão + delivery id), apontando o evento que ela
--      carregou. Só o service_role lê ou escreve.
--   2. `aceitar_entrega_inbox_chatwoot`: numa transação, trava a conexão
--      (`for share`, o desligamento espera a entrega em curso), recusa conexão
--      fora do escopo, de outro provedor ou desligada, grava o evento com
--      `insert ... on conflict do nothing` e a entrega do mesmo jeito. O mesmo
--      delivery id com outro evento é recusado (`23505`) e nada fica gravado.
--      A revisão vai na chave, que o app monta (versão `v2:`).
--   3. A função legada continua, com o mesmo corpo: o app do MSG-004 precisa
--      dela se o código for revertido. O app do MSG-005 não a chama.
--
-- O QUE NÃO MUDA: `inbox_eventos_chatwoot` (colunas, índice único por
-- organização + conexão + chave, grants e policy), conclusão e replay.
--
-- RECUPERAÇÃO: forward-only. Ver docs/operations/msg-005-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Entregas.
-- ---------------------------------------------------------------------------
create table if not exists public.inbox_entregas_chatwoot (
    id              uuid primary key default gen_random_uuid(),
    organizacao_id  uuid not null references public.organizacoes(id) on delete cascade,
    conexao_id      uuid not null references public.conexoes_integracao(id) on delete cascade,
    delivery_id     text not null,
    evento_id       uuid not null references public.inbox_eventos_chatwoot(id) on delete cascade,
    chave_evento    text not null,
    recebida_em     timestamptz not null default now(),
    constraint ck_inbox_entregas_chatwoot_delivery_id
        check (delivery_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);

create unique index if not exists uq_inbox_entregas_chatwoot_conexao_delivery
    on public.inbox_entregas_chatwoot(organizacao_id, conexao_id, delivery_id);
create index if not exists idx_inbox_entregas_chatwoot_evento
    on public.inbox_entregas_chatwoot(evento_id);
create index if not exists idx_inbox_entregas_chatwoot_conexao
    on public.inbox_entregas_chatwoot(conexao_id);

alter table public.inbox_entregas_chatwoot enable row level security;
revoke all on public.inbox_entregas_chatwoot from public, anon, authenticated;
grant select, insert, delete on public.inbox_entregas_chatwoot to service_role;

-- ---------------------------------------------------------------------------
-- 2. Aceite atômico da entrega.
-- ---------------------------------------------------------------------------
create or replace function public.aceitar_entrega_inbox_chatwoot(
    p_organizacao_id  uuid,
    p_conexao_id      uuid,
    p_user_id         uuid,
    p_inbox_id        bigint,
    p_delivery_id     text,
    p_idempotency_key text,
    p_event_type      text,
    p_payload         jsonb
)
returns table (
    evento_id       uuid,
    status          text,
    is_duplicate    boolean,
    duplicata       text,
    cached_response jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_conexao   record;
    v_evento_id uuid;
    v_entrega   record;
    v_duplicata text;
begin
    if p_organizacao_id is null or p_conexao_id is null
       or coalesce(length(p_idempotency_key), 0) not between 1 and 512
       or coalesce(length(p_event_type), 0) not between 1 and 64
       or p_payload is null or jsonb_typeof(p_payload) <> 'object'
       or octet_length(p_payload::text) > 262144 then
        raise exception 'MSG-005: entrada invalida' using errcode = '22023';
    end if;

    -- O desligamento (update de status) espera esta transação, e a entrega
    -- que chega depois dele o enxerga.
    select c.organizacao_id, c.provedor, c.status into v_conexao
      from public.conexoes_integracao c
     where c.id = p_conexao_id
       for share;
    if not found or v_conexao.organizacao_id <> p_organizacao_id or v_conexao.provedor <> 'chatwoot' then
        raise exception 'MSG-005: conexao fora do escopo' using errcode = '42501';
    end if;
    if v_conexao.status = 'desconectado' then
        raise exception 'MSG-005: conexao desligada' using errcode = '55000';
    end if;

    insert into public.inbox_eventos_chatwoot as e
        (organizacao_id, conexao_id, user_id, inbox_id, idempotency_key, event_type, payload, status, attempts)
    values
        (p_organizacao_id, p_conexao_id, p_user_id, p_inbox_id, p_idempotency_key, p_event_type, p_payload, 'received', 0)
    on conflict (organizacao_id, conexao_id, idempotency_key) do nothing
    returning e.id into v_evento_id;

    if v_evento_id is null then
        v_duplicata := 'evento';
        select e.id into strict v_evento_id
          from public.inbox_eventos_chatwoot e
         where e.organizacao_id = p_organizacao_id
           and e.conexao_id = p_conexao_id
           and e.idempotency_key = p_idempotency_key;
    end if;

    if p_delivery_id is not null then
        insert into public.inbox_entregas_chatwoot as d
            (organizacao_id, conexao_id, delivery_id, evento_id, chave_evento)
        values
            (p_organizacao_id, p_conexao_id, p_delivery_id, v_evento_id, p_idempotency_key)
        on conflict (organizacao_id, conexao_id, delivery_id) do nothing;

        if not found then
            select d.evento_id, d.chave_evento into strict v_entrega
              from public.inbox_entregas_chatwoot d
             where d.organizacao_id = p_organizacao_id
               and d.conexao_id = p_conexao_id
               and d.delivery_id = p_delivery_id;
            -- Mesmo delivery id com outro evento: a transação inteira aborta,
            -- inclusive o evento que esta chamada acabou de gravar.
            if v_entrega.chave_evento <> p_idempotency_key then
                raise exception 'MSG-005: delivery id reutilizado com outro evento' using errcode = '23505';
            end if;
            v_duplicata := 'entrega';
        end if;
    end if;

    return query
        select e.id, e.status, v_duplicata is not null, v_duplicata, e.response_body
          from public.inbox_eventos_chatwoot e
         where e.id = v_evento_id;
end;
$$;

revoke all on function public.aceitar_entrega_inbox_chatwoot(uuid, uuid, uuid, bigint, text, text, text, jsonb)
    from public, anon, authenticated;
grant execute on function public.aceitar_entrega_inbox_chatwoot(uuid, uuid, uuid, bigint, text, text, text, jsonb)
    to service_role;

-- ---------------------------------------------------------------------------
-- 3. Autoverificação.
-- ---------------------------------------------------------------------------
do $$
declare
    v_texto text;
begin
    if not (select relrowsecurity from pg_class where oid = 'public.inbox_entregas_chatwoot'::regclass) then
        raise exception 'MSG-005: inbox_entregas_chatwoot sem RLS';
    end if;

    select string_agg(r.rolname || ':' || p.privilegio, ', ') into v_texto
      from (values ('authenticated'), ('anon')) as r(rolname)
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(privilegio)
     where has_table_privilege(r.rolname, 'public.inbox_entregas_chatwoot', p.privilegio);
    if v_texto is not null then
        raise exception 'MSG-005: o navegador acessa as entregas (%)', v_texto;
    end if;

    if has_function_privilege('authenticated', 'public.aceitar_entrega_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,text,jsonb)', 'execute')
       or has_function_privilege('anon', 'public.aceitar_entrega_inbox_chatwoot(uuid,uuid,uuid,bigint,text,text,text,jsonb)', 'execute') then
        raise exception 'MSG-005: o navegador executa aceitar_entrega_inbox_chatwoot';
    end if;

    if not exists (select 1 from pg_index i
                    where i.indexrelid = 'public.uq_inbox_entregas_chatwoot_conexao_delivery'::regclass and i.indisunique)
       or not exists (select 1 from pg_index i
                       where i.indexrelid = 'public.uq_inbox_eventos_chatwoot_conexao_key'::regclass and i.indisunique) then
        raise exception 'MSG-005: dedup de entrega ou de evento sem indice unico';
    end if;
end;
$$;

notify pgrst, 'reload schema';
