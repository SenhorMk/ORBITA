-- 89_consumidor_inbox_caso_triage.sql (ordem 92, depois da 88 do MSG-005)
--
-- Forward-only. MSG-006: um worker consome a inbox do Chatwoot e transforma a
-- mensagem recebida em conversa e caso SAC em TRIAGE. Espelho, caso, auditoria
-- e conclusão da inbox acontecem numa só transação.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia canônica 01-88):
--   - O webhook grava a inbox e consome na mesma requisição, em chamadas REST
--     separadas: uma queda entre elas deixa espelho sem conclusão.
--   - `inbox_eventos_chatwoot` não tem lease: duas entregas iguais em paralelo
--     reprocessam enquanto o evento não está `processed`.
--   - `concluir_evento_inbox_chatwoot` aceita qualquer transição, inclusive
--     tirar um evento de `processed`.
--   - Não existe caso SAC; a mensagem recebida só vira espelho.
--   - As revisões são aplicadas na ordem de chegada: a última que chega ganha.
--
-- O QUE MUDA:
--   1. Inbox ganha lease, fencing token, `available_at`, `disposicao` e o vínculo
--      com o caso. `processed` e `ignored` passam a ser terminais, por gatilho.
--   2. `sac_cases`: caso por organização, com FK composta para a conversa e para
--      a mensagem de origem. No máximo um caso aberto por conversa e um caso por
--      mensagem de origem, por índice único. Ator de sistema explícito.
--   3. `reivindicar_eventos_inbox_chatwoot`: claim com `skip locked`; retoma lease
--      vencida; tentativas esgotadas viram falha definitiva; conexão desligada
--      não é consumida.
--   4. `aplicar_evento_inbox_chatwoot`: a transação única. Confere posse e fencing
--      com a linha travada, serializa por conversa, grava espelho, caso e
--      auditoria e conclui o evento. Organização e conexão vêm da linha da inbox,
--      nunca do comando.
--   5. `registrar_falha_evento_inbox_chatwoot`: falha com fencing, backoff e
--      código sem texto livre.
--   6. Revisões: `status_revisao_em` e `conteudo_revisao_em` nos espelhos, só com
--      versão vinda do provedor. Um gatilho vale para qualquer gravador: revisão
--      mais velha, ou escrita que declara não ter versão, não sobrescreve a comprovada.
--   7. As funções legadas de conclusão e replay respeitam a lease.
--   8. `orbita_worker_inbox`: papel NOLOGIN que só executa as três funções do
--      consumo. Preparado e provado no laboratório; nada aqui o habilita.
--
-- O QUE NÃO MUDA: `aceitar_entrega_inbox_chatwoot`, chaves de dedup e o espelho
-- gravado pelo sync. Nenhuma linha existente muda de estado aqui.
--
-- RECUPERAÇÃO: forward-only. Ver docs/operations/msg-006-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Casos SAC.
-- ---------------------------------------------------------------------------
-- A FK composta da origem precisa deste único; contatos e conversas já o têm.
create unique index if not exists uq_chatwoot_messages_org_id_local
    on public.chatwoot_messages(organizacao_id, id_local);

create table if not exists public.sac_cases (
    id                        uuid primary key default gen_random_uuid(),
    organizacao_id            uuid not null references public.organizacoes(id) on delete cascade,
    conversa_id_local         uuid not null,
    mensagem_origem_id_local  uuid,
    evento_origem_id          uuid,
    caso_anterior_id          uuid,
    phase                     text not null default 'TRIAGE',
    version                   integer not null default 1,
    ator_tipo                 text not null default 'system',
    ator_ref                  text not null default 'worker:inbox_chatwoot',
    ultima_mensagem_em        timestamptz not null default now(),
    created_at                timestamptz not null default now(),
    updated_at                timestamptz not null default now(),
    constraint ck_sac_cases_phase check (phase in (
        'TRIAGE', 'COLLECTING_INFORMATION', 'IDENTIFIED', 'RESOLUTION_PROPOSED', 'RESOLUTION_ACCEPTED',
        'EXECUTING', 'RESOLVED', 'CLOSED', 'CANCELLED')),
    constraint ck_sac_cases_version check (version >= 1),
    constraint ck_sac_cases_ator check (ator_tipo = 'system' and length(ator_ref) between 1 and 128),
    constraint uq_sac_cases_org_id unique (organizacao_id, id),
    constraint fk_sac_cases_conversa foreign key (organizacao_id, conversa_id_local)
        references public.chatwoot_conversations(organizacao_id, id_local) on delete cascade,
    constraint fk_sac_cases_mensagem_origem foreign key (organizacao_id, mensagem_origem_id_local)
        references public.chatwoot_messages(organizacao_id, id_local) on delete set null (mensagem_origem_id_local),
    constraint fk_sac_cases_caso_anterior foreign key (organizacao_id, caso_anterior_id)
        references public.sac_cases(organizacao_id, id) on delete set null (caso_anterior_id)
);

-- A regra: uma conversa tem no máximo um caso aberto, e uma mensagem abre no
-- máximo um caso em toda a vida da mensagem.
create unique index if not exists uq_sac_cases_conversa_aberto
    on public.sac_cases(organizacao_id, conversa_id_local)
    where phase not in ('RESOLVED', 'CLOSED', 'CANCELLED');
create unique index if not exists uq_sac_cases_mensagem_origem
    on public.sac_cases(organizacao_id, mensagem_origem_id_local)
    where mensagem_origem_id_local is not null;
create index if not exists idx_sac_cases_org_phase_atualizacao
    on public.sac_cases(organizacao_id, phase, updated_at desc);
create index if not exists idx_sac_cases_conversa
    on public.sac_cases(organizacao_id, conversa_id_local, created_at desc);
create index if not exists idx_sac_cases_caso_anterior
    on public.sac_cases(organizacao_id, caso_anterior_id);

alter table public.sac_cases enable row level security;
revoke all on public.sac_cases from public, anon, authenticated;
grant select on public.sac_cases to service_role;

-- ---------------------------------------------------------------------------
-- 2. Lease, fencing e disposição na inbox; revisão nos espelhos.
-- ---------------------------------------------------------------------------
alter table public.inbox_eventos_chatwoot
    add column if not exists lease_owner      text,
    add column if not exists lease_expires_at timestamptz,
    add column if not exists fencing_token    bigint not null default 0,
    add column if not exists available_at     timestamptz not null default now(),
    add column if not exists disposicao       text,
    add column if not exists caso_id          uuid;

alter table public.inbox_eventos_chatwoot
    add constraint ck_inbox_eventos_chatwoot_disposicao check (disposicao in (
        'caso_aberto', 'mensagem_no_caso', 'espelho_atualizado', 'revisao_atrasada',
        'conversa_nao_espelhada', 'conexao_nao_comprovada', 'classificacao_inconclusiva', 'evento_desconhecido',
        'conexao_removida', 'falha_definitiva')),
    add constraint fk_inbox_eventos_chatwoot_caso foreign key (organizacao_id, caso_id)
        references public.sac_cases(organizacao_id, id) on delete set null (caso_id);

create index if not exists idx_inbox_eventos_chatwoot_elegiveis
    on public.inbox_eventos_chatwoot(created_at)
    where status in ('received', 'processing', 'failed');
create index if not exists idx_inbox_eventos_chatwoot_caso
    on public.inbox_eventos_chatwoot(organizacao_id, caso_id);

alter table public.chatwoot_conversations add column if not exists status_revisao_em timestamptz;
alter table public.chatwoot_messages add column if not exists conteudo_revisao_em timestamptz;

create or replace function public.fn_inbox_chatwoot_terminal()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if old.status in ('processed', 'ignored') and new.status <> old.status then
        raise exception 'Evento da inbox concluido nao muda de estado (%).', old.status using errcode = '55000';
    end if;
    return new;
end;
$$;

drop trigger if exists tg_inbox_chatwoot_terminal on public.inbox_eventos_chatwoot;
create trigger tg_inbox_chatwoot_terminal
    before update of status on public.inbox_eventos_chatwoot
    for each row execute function public.fn_inbox_chatwoot_terminal();

-- Versão comprovada não recua, venha de quem vier: o worker, o sync ou o que vier
-- depois. Quem grava sem versão declara `null`; a coluna intocada (retenção, adoção
-- de conexão) não é escrita de conteúdo versionado e passa. Empate aplica: o provedor
-- marca em segundos, e duas revisões no mesmo segundo chegam na ordem da inbox.
create or replace function public.fn_espelho_chatwoot_revisao()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if tg_table_name = 'chatwoot_conversations' then
        if old.status_revisao_em is not null
           and (new.status_revisao_em is null or new.status_revisao_em < old.status_revisao_em) then
            new.status := old.status;
            new.status_revisao_em := old.status_revisao_em;
        end if;
    elsif old.conteudo_revisao_em is not null
          and (new.conteudo_revisao_em is null or new.conteudo_revisao_em < old.conteudo_revisao_em) then
        new.content := old.content;
        new.message_type := old.message_type;
        new.sender_name := old.sender_name;
        new.sender_id := old.sender_id;
        new.sender_type := old.sender_type;
        new.conteudo_revisao_em := old.conteudo_revisao_em;
    end if;
    return new;
end;
$$;

drop trigger if exists tg_chatwoot_conversations_revisao on public.chatwoot_conversations;
create trigger tg_chatwoot_conversations_revisao
    before update on public.chatwoot_conversations
    for each row execute function public.fn_espelho_chatwoot_revisao();
drop trigger if exists tg_chatwoot_messages_revisao on public.chatwoot_messages;
create trigger tg_chatwoot_messages_revisao
    before update on public.chatwoot_messages
    for each row execute function public.fn_espelho_chatwoot_revisao();

-- Trilha do consumo: sem ator humano, escrita pelas funções abaixo na mesma transação.
-- Não passa por `registrar_evento_auditoria`, que só aceita o JWT do `service_role`.
create or replace function public.auditar_consumo_inbox_chatwoot(
    p_organizacao_id uuid,
    p_acao           text,
    p_recurso        text,
    p_recurso_id     text,
    p_correlation_id text,
    p_metadata       jsonb
)
returns void
language sql
security invoker
set search_path = ''
as $$
    insert into public.eventos_auditoria_sistema (organizacao_id, actor_id, acao, recurso, recurso_id, correlation_id, metadata)
    values (p_organizacao_id, null, p_acao, p_recurso, p_recurso_id, p_correlation_id, p_metadata);
$$;

-- ---------------------------------------------------------------------------
-- 3. Funções legadas: continuam para o rollback de código, sem atropelar a lease.
-- ---------------------------------------------------------------------------
create or replace function public.concluir_evento_inbox_chatwoot(
    p_evento_id uuid,
    p_status text,
    p_response_body jsonb default null,
    p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.inbox_eventos_chatwoot
    set status = p_status,
        response_body = case when p_status = 'processed' then p_response_body else response_body end,
        last_error = p_error,
        attempts = attempts + 1,
        processed_at = case when p_status in ('processed', 'ignored') then now() else processed_at end,
        updated_at = now()
    where id = p_evento_id
      and status not in ('processed', 'ignored')
      and coalesce(lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp();
end;
$$;

create or replace function public.preparar_replay_evento_inbox_chatwoot(
    p_evento_id uuid
)
returns table (
    evento_id uuid,
    organizacao_id uuid,
    conexao_id uuid,
    user_id uuid,
    inbox_id bigint,
    event_type text,
    payload jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.inbox_eventos_chatwoot e
    set status = 'processing',
        updated_at = now()
    where e.id = p_evento_id
      and e.status not in ('processed', 'ignored')
      and coalesce(e.lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp()
    returning e.id, e.organizacao_id, e.conexao_id, e.user_id, e.inbox_id, e.event_type, e.payload
       into evento_id, organizacao_id, conexao_id, user_id, inbox_id, event_type, payload;

    return next;
    return;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Claim.
-- ---------------------------------------------------------------------------
create or replace function public.reivindicar_eventos_inbox_chatwoot(
    p_worker text,
    p_limite integer,
    p_lease_segundos integer,
    p_recebidos_desde timestamptz
)
returns table (
    evento_id      uuid,
    organizacao_id uuid,
    conexao_id     uuid,
    inbox_id       bigint,
    event_type     text,
    payload        jsonb,
    correlation_id text,
    fencing_token  bigint,
    tentativa      integer,
    recebido_em    timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_max_tentativas constant integer := 8;
    v_agora timestamptz := clock_timestamp();
    v_esgotado record;
begin
    if coalesce(length(p_worker), 0) not between 1 and 128
       or p_limite is null or p_limite not between 1 and 50
       or p_lease_segundos is null or p_lease_segundos not between 5 and 300
       or p_recebidos_desde is null then
        raise exception 'MSG-006: entrada invalida' using errcode = '22023';
    end if;

    -- Evento que derruba o worker não fica em ciclo: tentativas esgotadas param aqui.
    for v_esgotado in
        update public.inbox_eventos_chatwoot e
           set status = 'failed',
               disposicao = 'falha_definitiva',
               last_error = 'tentativas_esgotadas',
               lease_owner = null,
               lease_expires_at = null,
               updated_at = now()
         where e.id in (
            select x.id
              from public.inbox_eventos_chatwoot x
             where x.status in ('received', 'processing', 'failed')
               and x.created_at >= p_recebidos_desde
               and x.attempts >= v_max_tentativas
               and x.disposicao is null
               and coalesce(x.lease_expires_at, '-infinity'::timestamptz) <= v_agora
             order by x.created_at
             limit p_limite
               for update skip locked)
        returning e.id, e.organizacao_id, e.correlation_id, e.event_type, e.attempts
    loop
        perform public.auditar_consumo_inbox_chatwoot(
            v_esgotado.organizacao_id, 'chatwoot.inbox_event_failed', 'inbox_evento_chatwoot', v_esgotado.id::text,
            v_esgotado.correlation_id,
            jsonb_build_object('tipo', v_esgotado.event_type, 'tentativas', v_esgotado.attempts,
                               'codigo', 'tentativas_esgotadas', '_source', 'worker'));
    end loop;

    return query
    with candidatos as (
        select e.id
          from public.inbox_eventos_chatwoot e
          left join public.conexoes_integracao c on c.id = e.conexao_id
         where (c.id is null or c.status <> 'desconectado')
           and e.created_at >= p_recebidos_desde
           and e.disposicao is null
           and e.attempts < v_max_tentativas
           and ((e.status in ('received', 'failed') and e.available_at <= v_agora)
                or (e.status = 'processing' and coalesce(e.lease_expires_at, '-infinity'::timestamptz) <= v_agora))
         order by e.created_at
         limit p_limite
           for update of e skip locked
    )
    update public.inbox_eventos_chatwoot e
       set status = 'processing',
           lease_owner = p_worker,
           lease_expires_at = v_agora + make_interval(secs => p_lease_segundos),
           fencing_token = e.fencing_token + 1,
           attempts = e.attempts + 1,
           updated_at = now()
      from candidatos k
     where e.id = k.id
    returning e.id, e.organizacao_id, e.conexao_id, e.inbox_id, e.event_type, e.payload,
              e.correlation_id, e.fencing_token, e.attempts, e.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. A transação única do consumo.
-- ---------------------------------------------------------------------------
create or replace function public.aplicar_evento_inbox_chatwoot(
    p_evento_id     uuid,
    p_worker        text,
    p_fencing_token bigint,
    p_comando       jsonb
)
returns table (
    desfecho           text,
    disposicao         text,
    conversa_id_local  uuid,
    mensagem_id_local  uuid,
    caso_id            uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_evento        record;
    v_conexao       record;
    v_acao          text := p_comando ->> 'acao';
    v_contato       jsonb := p_comando -> 'contato';
    v_conversa      jsonb := p_comando -> 'conversa';
    v_mensagem      jsonb := p_comando -> 'mensagem';
    v_revisao_status   timestamptz;
    v_revisao_conteudo timestamptz;
    v_momento       timestamptz;
    v_conversa_ext  integer;
    v_contato_local uuid;
    v_conversa_local uuid;
    v_mensagem_local uuid;
    v_caso_id       uuid;
    v_caso_anterior uuid;
    v_mapa_org      uuid;
    v_disposicao    text;
    v_status_final  text := 'processed';
    v_linhas        integer;
    v_ator_id       uuid;
begin
    if p_evento_id is null or p_comando is null or jsonb_typeof(p_comando) <> 'object'
       or v_acao is null or v_acao not in ('espelhar', 'status', 'ignorar') then
        raise exception 'MSG-006: comando invalido' using errcode = '22023';
    end if;

    -- A linha travada é a posse: o claim de outro worker pula esta linha, e a
    -- expiração é conferida depois de ganhar o lock, não antes.
    select e.* into v_evento
      from public.inbox_eventos_chatwoot e
     where e.id = p_evento_id
       for update;
    if not found
       or v_evento.status <> 'processing'
       or v_evento.lease_owner is distinct from p_worker
       or v_evento.fencing_token <> p_fencing_token
       or v_evento.lease_expires_at is null
       or v_evento.lease_expires_at <= clock_timestamp() then
        return query select 'posse_perdida'::text, null::text, null::uuid, null::uuid, null::uuid;
        return;
    end if;

    if p_comando ->> 'evento' is distinct from v_evento.event_type then
        raise exception 'MSG-006: comando de outro evento' using errcode = '22023';
    end if;

    -- O desligamento espera esta transação. Conexão desligada devolve o evento
    -- sem gastar tentativa; conexão removida não tem mais de onde vir efeito.
    select c.organizacao_id, c.provedor, c.status into v_conexao
      from public.conexoes_integracao c
     where c.id = v_evento.conexao_id
       for share;
    if found and v_conexao.status = 'desconectado'
       and v_conexao.organizacao_id = v_evento.organizacao_id and v_conexao.provedor = 'chatwoot' then
        update public.inbox_eventos_chatwoot e
           set status = 'received', lease_owner = null, lease_expires_at = null,
               attempts = greatest(e.attempts - 1, 0), updated_at = now()
         where e.id = p_evento_id;
        return query select 'conexao_desligada'::text, null::text, null::uuid, null::uuid, null::uuid;
        return;
    end if;

    if not found or v_conexao.organizacao_id <> v_evento.organizacao_id or v_conexao.provedor <> 'chatwoot' then
        v_acao := 'ignorar';
        v_disposicao := 'conexao_removida';
    elsif v_acao = 'ignorar' then
        v_disposicao := 'evento_desconhecido';
    end if;

    if v_acao <> 'ignorar' then
        -- Só o provedor prova versão. Sem ela, a escrita não passa de uma comprovada.
        v_revisao_status := (p_comando ->> 'revisao_status_em')::timestamptz;
        v_revisao_conteudo := (p_comando ->> 'revisao_conteudo_em')::timestamptz;
        v_conversa_ext := coalesce((v_conversa ->> 'id')::integer, (v_mensagem ->> 'conversa_id')::integer);
        v_ator_id := v_evento.user_id;

        -- `skip locked` separa eventos, não conversas: dois comandos da mesma
        -- conversa não rodam em paralelo.
        if v_conversa_ext is not null then
            perform pg_advisory_xact_lock(hashtextextended(
                'inbox_chatwoot:' || v_evento.conexao_id::text || ':' || v_conversa_ext::text, 0));
        end if;
    end if;

    if v_acao = 'status' then
        -- Status não adota linha legada: sem conexão provada, a conversa não muda.
        select v.id_local into v_conversa_local
          from public.chatwoot_conversations v
         where v.organizacao_id = v_evento.organizacao_id
           and v.conexao_id = v_evento.conexao_id
           and v.id_externo = v_conversa_ext::text;
        if v_conversa_local is null then
            v_status_final := 'ignored';
            v_disposicao := case when exists (
                select 1 from public.chatwoot_conversations v
                 where v.organizacao_id = v_evento.organizacao_id
                   and v.conexao_id is null
                   and v.id_externo = v_conversa_ext::text)
                then 'conexao_nao_comprovada' else 'conversa_nao_espelhada' end;
        else
            update public.chatwoot_conversations v
               set status = v_conversa ->> 'status',
                   status_revisao_em = v_revisao_status,
                   updated_at = now()
             where v.organizacao_id = v_evento.organizacao_id
               and v.id_local = v_conversa_local
               and (v.status_revisao_em is null or v.status_revisao_em <= v_revisao_status);
            get diagnostics v_linhas = row_count;
            v_disposicao := case when v_linhas = 0 then 'revisao_atrasada' else 'espelho_atualizado' end;
        end if;
    elsif v_acao = 'espelhar' then
        if v_evento.inbox_id is not null then
            insert into public.chatwoot_inboxes as i (organizacao_id, conexao_id, inbox_id, account_id, user_id)
            values (v_evento.organizacao_id, v_evento.conexao_id, v_evento.inbox_id, p_comando ->> 'account_id', v_ator_id)
            on conflict (conexao_id, inbox_id) do nothing;
            select i.organizacao_id into v_mapa_org
              from public.chatwoot_inboxes i
             where i.conexao_id = v_evento.conexao_id and i.inbox_id = v_evento.inbox_id;
            if v_mapa_org is distinct from v_evento.organizacao_id then
                raise exception 'MSG-006: inbox mapeada para outra organizacao' using errcode = '23514';
            end if;
        end if;

        if v_contato is not null and jsonb_typeof(v_contato) = 'object' then
            select public.chatwoot_contato_local(v_evento.organizacao_id, v_evento.conexao_id, (v_contato ->> 'id')::integer)
              into v_contato_local;
            if v_contato_local is null then
                insert into public.chatwoot_contacts as c
                    (id, id_externo, organizacao_id, conexao_id, user_id, name, email, phone_number, phone_normalizado, avatar_url)
                values ((v_contato ->> 'id')::integer, v_contato ->> 'id', v_evento.organizacao_id, v_evento.conexao_id, v_ator_id,
                        coalesce(v_contato ->> 'nome', 'Cliente WhatsApp'), v_contato ->> 'email', v_contato ->> 'telefone',
                        v_contato ->> 'telefone_normalizado', v_contato ->> 'avatar_url')
                on conflict (organizacao_id, conexao_id, id_externo) do nothing
                returning c.id_local into v_contato_local;
                -- O mesmo contato em outra conversa ou no sync: a linha é a da conexão.
                if v_contato_local is null then
                    select c.id_local into strict v_contato_local
                      from public.chatwoot_contacts c
                     where c.organizacao_id = v_evento.organizacao_id
                       and c.conexao_id = v_evento.conexao_id
                       and c.id_externo = v_contato ->> 'id';
                end if;
            else
                update public.chatwoot_contacts c
                   set name = coalesce(v_contato ->> 'nome', c.name),
                       email = coalesce(v_contato ->> 'email', c.email),
                       phone_number = coalesce(v_contato ->> 'telefone', c.phone_number),
                       phone_normalizado = coalesce(v_contato ->> 'telefone_normalizado', c.phone_normalizado),
                       avatar_url = coalesce(v_contato ->> 'avatar_url', c.avatar_url),
                       conexao_id = v_evento.conexao_id,
                       updated_at = now()
                 where c.organizacao_id = v_evento.organizacao_id and c.id_local = v_contato_local;
            end if;
        end if;

        if v_conversa is not null and jsonb_typeof(v_conversa) = 'object' then
            v_contato_local := coalesce(v_contato_local, public.chatwoot_contato_local(
                v_evento.organizacao_id, v_evento.conexao_id, (v_conversa ->> 'contato_id')::integer));
            if v_contato_local is null then
                raise exception 'MSG-006: contato da conversa nao espelhado' using errcode = '23503';
            end if;
            select public.chatwoot_conversa_local(v_evento.organizacao_id, v_evento.conexao_id, (v_conversa ->> 'id')::integer)
              into v_conversa_local;
            if v_conversa_local is null then
                insert into public.chatwoot_conversations as v
                    (id, id_externo, organizacao_id, conexao_id, user_id, contato_id_local, contact_id,
                     display_id, status, inbox_id, channel, status_revisao_em)
                values ((v_conversa ->> 'id')::integer, v_conversa ->> 'id', v_evento.organizacao_id, v_evento.conexao_id, v_ator_id,
                        v_contato_local, (v_conversa ->> 'contato_id')::integer, (v_conversa ->> 'display_id')::integer,
                        coalesce(v_conversa ->> 'status', 'open'), (v_conversa ->> 'inbox_id')::integer,
                        v_conversa ->> 'canal', v_revisao_status)
                on conflict (organizacao_id, conexao_id, id_externo) do nothing
                returning v.id_local into v_conversa_local;
                if v_conversa_local is null then
                    select v.id_local into strict v_conversa_local
                      from public.chatwoot_conversations v
                     where v.organizacao_id = v_evento.organizacao_id
                       and v.conexao_id = v_evento.conexao_id
                       and v.id_externo = v_conversa ->> 'id';
                end if;
            else
                update public.chatwoot_conversations v
                   set contato_id_local = v_contato_local,
                       contact_id = (v_conversa ->> 'contato_id')::integer,
                       display_id = coalesce((v_conversa ->> 'display_id')::integer, v.display_id),
                       inbox_id = coalesce((v_conversa ->> 'inbox_id')::integer, v.inbox_id),
                       channel = coalesce(v_conversa ->> 'canal', v.channel),
                       status = coalesce(v_conversa ->> 'status', v.status),
                       status_revisao_em = case when v_conversa ->> 'status' is null then v.status_revisao_em else v_revisao_status end,
                       conexao_id = v_evento.conexao_id,
                       updated_at = now()
                 where v.organizacao_id = v_evento.organizacao_id and v.id_local = v_conversa_local;
            end if;
        end if;

        v_disposicao := 'espelho_atualizado';

        if v_mensagem is not null and jsonb_typeof(v_mensagem) = 'object' then
            v_conversa_local := coalesce(v_conversa_local, public.chatwoot_conversa_local(
                v_evento.organizacao_id, v_evento.conexao_id, (v_mensagem ->> 'conversa_id')::integer));
            if v_conversa_local is null then
                raise exception 'MSG-006: conversa da mensagem nao espelhada' using errcode = '23503';
            end if;

            select case when count(*) = 1 then (array_agg(m.id_local))[1] end into v_mensagem_local
              from public.chatwoot_messages m
             where m.organizacao_id = v_evento.organizacao_id
               and m.id_externo = v_mensagem ->> 'id'
               and (m.conexao_id is null or m.conexao_id = v_evento.conexao_id);

            if v_mensagem_local is null then
                insert into public.chatwoot_messages as m
                    (id, id_externo, organizacao_id, conexao_id, user_id, conversa_id_local, conversation_id, content,
                     message_type, sender_name, sender_id, sender_type, created_at, conteudo_revisao_em)
                values ((v_mensagem ->> 'id')::integer, v_mensagem ->> 'id', v_evento.organizacao_id, v_evento.conexao_id, v_ator_id,
                        v_conversa_local, (v_mensagem ->> 'conversa_id')::integer, coalesce(v_mensagem ->> 'conteudo', ''),
                        v_mensagem ->> 'tipo', v_mensagem ->> 'remetente_nome', (v_mensagem ->> 'remetente_id')::integer,
                        v_mensagem ->> 'remetente_tipo', coalesce((v_mensagem ->> 'criada_em')::timestamptz, v_evento.created_at),
                        v_revisao_conteudo)
                on conflict (organizacao_id, conexao_id, id_externo) do nothing
                returning m.id_local into v_mensagem_local;
                if v_mensagem_local is null then
                    select m.id_local into strict v_mensagem_local
                      from public.chatwoot_messages m
                     where m.organizacao_id = v_evento.organizacao_id
                       and m.conexao_id = v_evento.conexao_id
                       and m.id_externo = v_mensagem ->> 'id';
                end if;
            elsif v_mensagem ->> 'modo' = 'sobrescrever' then
                -- Edição: a revisão mais nova fica, em qualquer ordem de chegada.
                update public.chatwoot_messages m
                   set content = coalesce(v_mensagem ->> 'conteudo', ''),
                       message_type = v_mensagem ->> 'tipo',
                       sender_name = v_mensagem ->> 'remetente_nome',
                       sender_id = (v_mensagem ->> 'remetente_id')::integer,
                       sender_type = v_mensagem ->> 'remetente_tipo',
                       conteudo_revisao_em = v_revisao_conteudo,
                       conexao_id = v_evento.conexao_id,
                       updated_at = now()
                 where m.organizacao_id = v_evento.organizacao_id
                   and m.id_local = v_mensagem_local
                   and (m.conteudo_revisao_em is null or m.conteudo_revisao_em <= v_revisao_conteudo);
                get diagnostics v_linhas = row_count;
                if v_linhas = 0 then
                    v_disposicao := 'revisao_atrasada';
                end if;
            else
                -- `message_created` atrasado não apaga a edição que chegou antes;
                -- só adota a linha legada.
                update public.chatwoot_messages m
                   set conexao_id = v_evento.conexao_id
                 where m.organizacao_id = v_evento.organizacao_id
                   and m.id_local = v_mensagem_local
                   and m.conexao_id is null;
            end if;
        end if;

        if coalesce((p_comando ->> 'abre_caso')::boolean, false) then
            if v_mensagem_local is null then
                raise exception 'MSG-006: abrir caso exige a mensagem' using errcode = '22023';
            end if;
            -- Última guarda da regra: só mensagem provada como recebida do contato.
            if v_mensagem ->> 'tipo' is distinct from 'incoming'
               or v_mensagem ->> 'remetente_tipo' is distinct from 'contact' then
                raise exception 'MSG-006: abrir caso exige mensagem recebida do contato' using errcode = '22023';
            end if;
            v_momento := coalesce((v_mensagem ->> 'criada_em')::timestamptz, v_evento.created_at);

            select s.id into v_caso_id
              from public.sac_cases s
             where s.organizacao_id = v_evento.organizacao_id
               and (s.mensagem_origem_id_local = v_mensagem_local
                    or (s.conversa_id_local = v_conversa_local and s.phase not in ('RESOLVED', 'CLOSED', 'CANCELLED')))
             order by s.mensagem_origem_id_local = v_mensagem_local desc nulls last
             limit 1;

            if v_caso_id is not null then
                update public.sac_cases s
                   set ultima_mensagem_em = greatest(s.ultima_mensagem_em, v_momento),
                       updated_at = now()
                 where s.organizacao_id = v_evento.organizacao_id and s.id = v_caso_id;
                v_disposicao := 'mensagem_no_caso';
            else
                -- Depois de um caso terminal, a mensagem nova abre outro, ligado a ele.
                select s.id into v_caso_anterior
                  from public.sac_cases s
                 where s.organizacao_id = v_evento.organizacao_id and s.conversa_id_local = v_conversa_local
                 order by s.created_at desc
                 limit 1;

                insert into public.sac_cases as s
                    (organizacao_id, conversa_id_local, mensagem_origem_id_local, evento_origem_id, caso_anterior_id, ultima_mensagem_em)
                values (v_evento.organizacao_id, v_conversa_local, v_mensagem_local, v_evento.id, v_caso_anterior, v_momento)
                returning s.id into v_caso_id;

                perform public.auditar_consumo_inbox_chatwoot(
                    v_evento.organizacao_id, 'sac.case_opened', 'sac_case', v_caso_id::text,
                    v_evento.correlation_id,
                    jsonb_build_object('evento_id', v_evento.id, 'conversa_id_local', v_conversa_local,
                                       'fase', 'TRIAGE', 'fencing_token', v_evento.fencing_token, '_source', 'worker'));
                v_disposicao := 'caso_aberto';
            end if;
        elsif coalesce((p_comando ->> 'classificacao_inconclusiva')::boolean, false)
              and v_disposicao = 'espelho_atualizado' then
            -- Espelhada, sem abrir caso: o operador vê que faltou prova.
            v_disposicao := 'classificacao_inconclusiva';
        end if;
    else
        v_status_final := case when v_acao = 'ignorar' then 'ignored' else v_status_final end;
    end if;

    update public.inbox_eventos_chatwoot e
       set status = v_status_final,
           disposicao = v_disposicao,
           caso_id = v_caso_id,
           response_body = jsonb_strip_nulls(jsonb_build_object(
               'success', true, 'event', v_evento.event_type, 'disposicao', v_disposicao,
               'conversaIdLocal', v_conversa_local, 'mensagemIdLocal', v_mensagem_local, 'casoId', v_caso_id)),
           last_error = null,
           lease_owner = null,
           lease_expires_at = null,
           processed_at = now(),
           updated_at = now()
     where e.id = p_evento_id;

    return query select 'aplicado'::text, v_disposicao, v_conversa_local, v_mensagem_local, v_caso_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Falha com fencing. O código é um identificador, nunca texto do provedor.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_falha_evento_inbox_chatwoot(
    p_evento_id     uuid,
    p_worker        text,
    p_fencing_token bigint,
    p_codigo        text,
    p_definitiva    boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_evento record;
begin
    if p_evento_id is null or p_definitiva is null or coalesce(p_codigo, '') !~ '^[a-z0-9_]{1,64}$' then
        raise exception 'MSG-006: entrada invalida' using errcode = '22023';
    end if;

    update public.inbox_eventos_chatwoot e
       set status = 'failed',
           disposicao = case when p_definitiva then 'falha_definitiva' end,
           last_error = p_codigo,
           available_at = clock_timestamp() + make_interval(secs => least(300, 5 * power(2, least(e.attempts, 10))::integer)),
           lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where e.id = p_evento_id
       and e.status = 'processing'
       and e.lease_owner = p_worker
       and e.fencing_token = p_fencing_token
       and e.lease_expires_at > clock_timestamp()
    returning e.organizacao_id, e.correlation_id, e.event_type, e.attempts, e.disposicao into v_evento;
    if not found then
        return null;
    end if;

    if p_definitiva then
        perform public.auditar_consumo_inbox_chatwoot(
            v_evento.organizacao_id, 'chatwoot.inbox_event_failed', 'inbox_evento_chatwoot', p_evento_id::text,
            v_evento.correlation_id,
            jsonb_build_object('tipo', v_evento.event_type, 'tentativas', v_evento.attempts,
                               'codigo', p_codigo, '_source', 'worker'));
    end if;
    return coalesce(v_evento.disposicao, 'nova_tentativa');
end;
$$;

revoke all on function public.reivindicar_eventos_inbox_chatwoot(text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.aplicar_evento_inbox_chatwoot(uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.registrar_falha_evento_inbox_chatwoot(uuid, text, bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.fn_inbox_chatwoot_terminal() from public, anon, authenticated;
revoke all on function public.fn_espelho_chatwoot_revisao() from public, anon, authenticated;
revoke all on function public.auditar_consumo_inbox_chatwoot(uuid, text, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.reivindicar_eventos_inbox_chatwoot(text, integer, integer, timestamptz) to service_role;
grant execute on function public.aplicar_evento_inbox_chatwoot(uuid, text, bigint, jsonb) to service_role;
grant execute on function public.registrar_falha_evento_inbox_chatwoot(uuid, text, bigint, text, boolean) to service_role;

-- Papel mínimo do worker: sem login, sem tabela, só as três funções. Enquanto o worker
-- rodar como `service_role`, o banco não o restringe a elas. Habilitar exige decisão:
-- ver docs/operations/msg-006-runbook.md §5.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'orbita_worker_inbox') then
        create role orbita_worker_inbox nologin noinherit;
    end if;
end;
$$;
grant usage on schema public to orbita_worker_inbox;
grant execute on function public.reivindicar_eventos_inbox_chatwoot(text, integer, integer, timestamptz) to orbita_worker_inbox;
grant execute on function public.aplicar_evento_inbox_chatwoot(uuid, text, bigint, jsonb) to orbita_worker_inbox;
grant execute on function public.registrar_falha_evento_inbox_chatwoot(uuid, text, bigint, text, boolean) to orbita_worker_inbox;

-- ---------------------------------------------------------------------------
-- 7. Eventos de auditoria (projeção SQL de `auditEventCatalog.ts`).
-- ---------------------------------------------------------------------------
insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('sac.case_opened', 1, 'sac', 'info', 'system', 1825, null,
     'Caso SAC aberto em TRIAGE pelo consumidor da inbox.'),
    ('chatwoot.inbox_event_failed', 1, 'integrations', 'warning', 'system', 365, null,
     'Evento da inbox do Chatwoot em falha definitiva: não será retomado sem correção.')
on conflict (nome) do nothing;

-- ---------------------------------------------------------------------------
-- 8. Autoverificação.
-- ---------------------------------------------------------------------------
do $$
declare
    v_texto text;
begin
    if not (select relrowsecurity from pg_class where oid = 'public.sac_cases'::regclass) then
        raise exception 'MSG-006: sac_cases sem RLS';
    end if;

    select string_agg(r.rolname || ':' || p.privilegio, ', ') into v_texto
      from (values ('authenticated'), ('anon')) as r(rolname)
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(privilegio)
     where has_table_privilege(r.rolname, 'public.sac_cases', p.privilegio);
    if v_texto is not null then
        raise exception 'MSG-006: o navegador acessa sac_cases (%)', v_texto;
    end if;

    select string_agg(r.rolname || ':' || p.privilegio, ', ') into v_texto
      from (values ('authenticated'), ('anon')) as r(rolname)
     cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(privilegio)
     where has_table_privilege(r.rolname, 'public.inbox_eventos_chatwoot', p.privilegio);
    if v_texto is not null then
        raise exception 'MSG-006: o navegador escreve na inbox (%)', v_texto;
    end if;

    select string_agg(f.assinatura || ':' || r.rolname, ', ') into v_texto
      from (values ('public.reivindicar_eventos_inbox_chatwoot(text,integer,integer,timestamptz)'),
                   ('public.aplicar_evento_inbox_chatwoot(uuid,text,bigint,jsonb)'),
                   ('public.registrar_falha_evento_inbox_chatwoot(uuid,text,bigint,text,boolean)'),
                   ('public.concluir_evento_inbox_chatwoot(uuid,text,jsonb,text)'),
                   ('public.preparar_replay_evento_inbox_chatwoot(uuid)'),
                   ('public.auditar_consumo_inbox_chatwoot(uuid,text,text,text,text,jsonb)')) as f(assinatura)
     cross join (values ('authenticated'), ('anon')) as r(rolname)
     where has_function_privilege(r.rolname, f.assinatura, 'execute');
    if v_texto is not null then
        raise exception 'MSG-006: o navegador aciona o consumidor (%)', v_texto;
    end if;

    if (select rolcanlogin or rolsuper or rolbypassrls from pg_roles where rolname = 'orbita_worker_inbox') then
        raise exception 'MSG-006: orbita_worker_inbox nao pode ter login nem ignorar RLS';
    end if;
    if pg_has_role('orbita_worker_inbox', 'service_role', 'member') then
        raise exception 'MSG-006: orbita_worker_inbox nao pode herdar service_role';
    end if;

    if not exists (select 1 from pg_index i where i.indexrelid = 'public.uq_sac_cases_conversa_aberto'::regclass and i.indisunique)
       or not exists (select 1 from pg_index i where i.indexrelid = 'public.uq_sac_cases_mensagem_origem'::regclass and i.indisunique) then
        raise exception 'MSG-006: regra do caso sem indice unico';
    end if;
end;
$$;

notify pgrst, 'reload schema';
