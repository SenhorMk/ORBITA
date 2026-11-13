-- 94_triagem_ia_sac.sql
-- Forward-only. MSG-013: triagem por IA de cada caso SAC, como trabalho interno
-- da outbox existente, com orçamento diário por organização e resultado
-- validado gravado em `ai_runs`.
--
-- ESTADO ANTERIOR (cadeia 01-93):
--   - O caso SAC nasce em TRIAGE (MSG-006) e ninguém o classifica: o atendente
--     lê a conversa inteira para saber o que a pessoa quer.
--   - A outbox só conhece destinos externos (`chatwoot`, `bling`,
--     `webhook_externo`), e o claim genérico pega qualquer evento pendente.
--
-- O QUE MUDA:
--   1. Outbox: destino `interno`, restrito ao tipo `sac.triagem`. O claim
--      genérico (`reivindicar_tentativas_outbox`) deixa de pegar `interno`:
--      só o consumidor da triagem o reivindica.
--   2. `ai_runs`: uma linha por execução (evento + fencing), com provedor,
--      modelo, versões de prompt e schema, tokens, latência, desfecho e o
--      resultado validado. Nenhum privilégio direto, nem para `service_role`.
--   3. Gatilho em `sac_cases`: caso aberto em TRIAGE/COLLECTING_INFORMATION, ou
--      que recebe mensagem nova, enfileira uma triagem (chave idempotente por
--      caso + momento da última mensagem). Sem segunda fila.
--   4. `reivindicar_triagens_sac`: o claim do worker, só `interno/sac.triagem`.
--   5. `iniciar_triagem_sac`: confere a posse, descarta trabalho de versão
--      vencida, reserva orçamento sob trava por organização e devolve o
--      contexto mínimo (até 5 mensagens recebidas do contato, cortadas).
--   6. `concluir_triagem_sac`: grava o desfecho, revalida a versão do caso e
--      conclui o evento na mesma transação. Resultado gravado é `confirmado`
--      com o id da execução como recibo. Falha de provedor (429, timeout, 5xx)
--      volta à fila como `nao_enviado`: o efeito deste trabalho é a gravação
--      local do resultado, e a transação prova que ela não aconteceu. A chamada
--      ao modelo acontece com o evento em `processing`, nunca em `in_flight`:
--      queda no meio devolve o trabalho à fila (custo repetido, coberto pelo
--      orçamento), sem efeito desconhecido.
--   7. `ler_triagem_do_caso_sac`: a última execução do caso atual da conversa,
--      para o cockpit.
--
-- O QUE NÃO MUDA: estados, gatilhos e reaper da outbox (MSG-007); o consumo da
-- inbox (MSG-006) e o envio (MSG-008). Nenhuma linha existente muda.
--
-- RECUPERAÇÃO: forward-only. Ver docs/operations/msg-013-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Destino interno na outbox.
-- ---------------------------------------------------------------------------
do $$
declare
    v_nome text;
begin
    for v_nome in
        select c.conname from pg_constraint c
         where c.conrelid = 'public.outbox_eventos'::regclass and c.contype = 'c'
           and pg_get_constraintdef(c.oid) ilike '%destination%'
           and c.conname <> 'ck_outbox_eventos_interno'
    loop
        execute format('alter table public.outbox_eventos drop constraint %I', v_nome);
    end loop;
end;
$$;

alter table public.outbox_eventos
    add constraint ck_outbox_eventos_destination
        check (destination in ('chatwoot', 'bling', 'webhook_externo', 'interno')) not valid,
    add constraint ck_outbox_eventos_interno
        check (destination <> 'interno' or event_type in ('sac.triagem')) not valid;
alter table public.outbox_eventos validate constraint ck_outbox_eventos_destination;
alter table public.outbox_eventos validate constraint ck_outbox_eventos_interno;

-- O claim genérico (MSG-007) nunca pega trabalho interno. Corpo idêntico ao da
-- migration 86, mais o filtro de destino.
create or replace function public.reivindicar_tentativas_outbox(
    p_worker_id      text,
    p_limit          integer default 20,
    p_lease_ttl_sec  integer default 300
)
returns table (
    evento_id         uuid,
    organizacao_id    uuid,
    conexao_id        uuid,
    destination       text,
    event_type        text,
    payload           jsonb,
    attempts          integer,
    max_attempts      integer,
    lease_owner       text,
    lease_expires_at  timestamptz,
    correlation_id    text,
    fencing_token     bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_worker_id is null or char_length(trim(p_worker_id)) = 0 or char_length(p_worker_id) > 200 then
        raise exception 'p_worker_id invalido.' using errcode = '22023';
    end if;
    if p_limit is null or p_limit < 1 or p_limit > 100 then
        raise exception 'p_limit fora de 1..100.' using errcode = '22023';
    end if;
    if p_lease_ttl_sec is null or p_lease_ttl_sec < 5 or p_lease_ttl_sec > 3600 then
        raise exception 'p_lease_ttl_sec fora de 5..3600.' using errcode = '22023';
    end if;

    return query
    with lote as (
        select o.id
          from public.outbox_eventos o
         where o.status in ('pending', 'failed_transient')
           and o.next_retry_at <= now()
           and o.destination <> 'interno'
         order by o.next_retry_at asc
         limit p_limit
         for update skip locked
    )
    update public.outbox_eventos o
       set status = 'processing',
           lease_owner = p_worker_id,
           lease_expires_at = now() + make_interval(secs => p_lease_ttl_sec),
           updated_at = now()
      from lote
     where o.id = lote.id
    returning o.id, o.organizacao_id, o.conexao_id, o.destination, o.event_type, o.payload,
              o.attempts, o.max_attempts, o.lease_owner, o.lease_expires_at, o.correlation_id,
              o.fencing_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Execuções de IA.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_runs (
    id                uuid primary key default gen_random_uuid(),
    organizacao_id    uuid not null references public.organizacoes(id) on delete cascade,
    tarefa            text not null default 'sac.triagem',
    caso_id           uuid not null,
    evento_outbox_id  uuid not null,
    fencing_token     bigint not null,
    -- A versão do caso a que o trabalho se refere: a última mensagem quando foi enfileirado.
    mensagens_ate     timestamptz not null,
    provedor          text not null,
    modelo            text not null,
    versao_prompt     text not null,
    versao_schema     integer not null,
    status            text not null default 'em_andamento',
    motivo            text,
    resultado         jsonb,
    -- Houve chamada ao modelo (ou pode ter havido): conta no orçamento.
    chamou_modelo     boolean not null default false,
    tokens_entrada    integer,
    tokens_saida      integer,
    reparos           smallint not null default 0,
    latencia_ms       integer,
    created_at        timestamptz not null default now(),
    concluida_em      timestamptz,
    constraint ck_ai_runs_tarefa check (tarefa in ('sac.triagem')),
    constraint ck_ai_runs_textos check (char_length(provedor) between 1 and 40 and char_length(modelo) between 1 and 100
                                        and char_length(versao_prompt) between 1 and 40),
    constraint ck_ai_runs_versao_schema check (versao_schema >= 1),
    constraint ck_ai_runs_status check (status in ('em_andamento', 'concluida', 'handoff', 'falha', 'obsoleta')),
    constraint ck_ai_runs_motivo check (motivo is null or motivo in (
        'schema_invalido', 'recusa', 'entrada_bloqueada', 'sem_orcamento', 'limite_do_provedor', 'timeout',
        'erro_do_provedor', 'caso_mudou', 'interrompida')),
    constraint ck_ai_runs_desfecho check (
        (status = 'em_andamento' and concluida_em is null and motivo is null and resultado is null)
        or (status = 'concluida' and concluida_em is not null and motivo is null and resultado is not null)
        or (status in ('handoff', 'falha') and concluida_em is not null and motivo is not null and resultado is null)
        or (status = 'obsoleta' and concluida_em is not null and motivo = 'caso_mudou')),
    constraint ck_ai_runs_resultado check (resultado is null
        or (jsonb_typeof(resultado) = 'object' and pg_column_size(resultado) <= 8192)),
    constraint ck_ai_runs_uso check (coalesce(tokens_entrada, 0) >= 0 and coalesce(tokens_saida, 0) >= 0
                                     and coalesce(latencia_ms, 0) >= 0 and reparos between 0 and 1),
    constraint uq_ai_runs_tentativa unique (evento_outbox_id, fencing_token),
    constraint fk_ai_runs_caso foreign key (organizacao_id, caso_id)
        references public.sac_cases(organizacao_id, id) on delete cascade,
    constraint fk_ai_runs_evento foreign key (organizacao_id, evento_outbox_id)
        references public.outbox_eventos(organizacao_id, id) on delete cascade
);

create index if not exists idx_ai_runs_caso on public.ai_runs (organizacao_id, caso_id, created_at desc);
create index if not exists idx_ai_runs_orcamento on public.ai_runs (organizacao_id, created_at);

alter table public.ai_runs enable row level security;
revoke all on public.ai_runs from public, anon, authenticated, service_role;

-- Uma execução termina uma vez; depois disso, nada muda.
create or replace function public.fn_ai_run_imutavel()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if old.status <> 'em_andamento'
       or new.id is distinct from old.id
       or new.organizacao_id is distinct from old.organizacao_id
       or new.tarefa is distinct from old.tarefa
       or new.caso_id is distinct from old.caso_id
       or new.evento_outbox_id is distinct from old.evento_outbox_id
       or new.fencing_token is distinct from old.fencing_token
       or new.mensagens_ate is distinct from old.mensagens_ate
       or new.provedor is distinct from old.provedor
       or new.modelo is distinct from old.modelo
       or new.versao_prompt is distinct from old.versao_prompt
       or new.versao_schema is distinct from old.versao_schema
       or new.created_at is distinct from old.created_at then
        raise exception 'MSG-013: execucao de IA concluida e imutavel.' using errcode = '23514';
    end if;
    return new;
end;
$$;

drop trigger if exists tg_ai_run_imutavel on public.ai_runs;
create trigger tg_ai_run_imutavel before update on public.ai_runs
    for each row execute function public.fn_ai_run_imutavel();

-- ---------------------------------------------------------------------------
-- 3. Enfileirar a triagem quando o caso abre ou recebe mensagem.
-- ---------------------------------------------------------------------------
create or replace function public.fn_sac_caso_enfileirar_triagem()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.phase not in ('TRIAGE', 'COLLECTING_INFORMATION') then
        return null;
    end if;
    if tg_op = 'UPDATE' and new.ultima_mensagem_em <= old.ultima_mensagem_em then
        return null;
    end if;
    perform public.registrar_evento_outbox(
        new.organizacao_id, null, null,
        'sac.triagem:' || new.id::text || ':' || to_char(new.ultima_mensagem_em at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
        'interno', 'sac.triagem',
        jsonb_build_object('caso_id', new.id, 'mensagens_ate', new.ultima_mensagem_em),
        3);
    return null;
end;
$$;

revoke all on function public.fn_sac_caso_enfileirar_triagem() from public, anon, authenticated, service_role;

drop trigger if exists tg_sac_caso_enfileirar_triagem on public.sac_cases;
create trigger tg_sac_caso_enfileirar_triagem
    after insert or update of ultima_mensagem_em on public.sac_cases
    for each row execute function public.fn_sac_caso_enfileirar_triagem();

-- ---------------------------------------------------------------------------
-- 4. Claim do worker de triagem.
-- ---------------------------------------------------------------------------
create or replace function public.reivindicar_triagens_sac(
    p_worker_id      text,
    p_limite         integer default 5,
    p_lease_ttl_sec  integer default 120
)
returns table (
    evento_id       uuid,
    organizacao_id  uuid,
    caso_id         uuid,
    mensagens_ate   timestamptz,
    attempts        integer,
    correlation_id  text,
    fencing_token   bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_worker_id is null or char_length(trim(p_worker_id)) = 0 or char_length(p_worker_id) > 200 then
        raise exception 'MSG-013: worker invalido.' using errcode = '22023';
    end if;
    if p_limite is null or p_limite not between 1 and 20 then
        raise exception 'MSG-013: limite fora de 1..20.' using errcode = '22023';
    end if;
    if p_lease_ttl_sec is null or p_lease_ttl_sec not between 30 and 600 then
        raise exception 'MSG-013: lease fora de 30..600.' using errcode = '22023';
    end if;

    return query
    with lote as (
        select o.id
          from public.outbox_eventos o
         where o.destination = 'interno' and o.event_type = 'sac.triagem'
           and o.status in ('pending', 'failed_transient')
           and o.next_retry_at <= now()
         order by o.next_retry_at asc
         limit p_limite
         for update skip locked
    )
    update public.outbox_eventos o
       set status = 'processing',
           lease_owner = p_worker_id,
           lease_expires_at = now() + make_interval(secs => p_lease_ttl_sec),
           updated_at = now()
      from lote
     where o.id = lote.id
    returning o.id, o.organizacao_id, (o.payload ->> 'caso_id')::uuid, (o.payload ->> 'mensagens_ate')::timestamptz,
              o.attempts, o.correlation_id, o.fencing_token;
end;
$$;

-- Evento ainda em posse deste worker, com este token e lease vigente; travado.
create or replace function public.sac_triagem_evento_em_posse(p_evento_id uuid, p_worker_id text, p_fencing_token bigint)
returns public.outbox_eventos
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_evt public.outbox_eventos;
begin
    select * into v_evt from public.outbox_eventos o where o.id = p_evento_id for update;
    if v_evt.id is null
       or v_evt.destination <> 'interno' or v_evt.event_type <> 'sac.triagem'
       or v_evt.status <> 'processing'
       or v_evt.lease_owner is distinct from p_worker_id
       or v_evt.fencing_token is distinct from p_fencing_token
       or v_evt.lease_expires_at is null or v_evt.lease_expires_at < now() then
        return null;
    end if;
    return v_evt;
end;
$$;

-- Conclui o evento com o id da execução como recibo.
create or replace function public.sac_triagem_confirmar_evento(p_evento_id uuid, p_worker_id text, p_fencing_token bigint, p_run_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.iniciar_despacho_outbox(p_evento_id, p_worker_id, p_fencing_token) then
        raise exception 'MSG-013: posse do evento perdida na conclusao.' using errcode = '40001';
    end if;
    return public.concluir_tentativa_outbox(p_evento_id, p_worker_id, p_fencing_token, 'confirmado', p_run_id::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Início: posse, versão, orçamento e contexto mínimo.
-- ---------------------------------------------------------------------------
create or replace function public.iniciar_triagem_sac(
    p_evento_id       uuid,
    p_worker_id       text,
    p_fencing_token   bigint,
    p_limite_diario   integer,
    p_provedor        text,
    p_modelo          text,
    p_versao_prompt   text,
    p_versao_schema   integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_evt       public.outbox_eventos;
    v_caso      public.sac_cases;
    v_ate       timestamptz;
    v_run_id    uuid;
    v_usadas    integer;
    v_desde     timestamptz;
    v_mensagens jsonb;
begin
    if p_limite_diario is null or p_limite_diario < 0 then
        raise exception 'MSG-013: limite diario invalido.' using errcode = '22023';
    end if;

    v_evt := public.sac_triagem_evento_em_posse(p_evento_id, p_worker_id, p_fencing_token);
    if v_evt.id is null then
        return jsonb_build_object('resultado', 'posse_perdida');
    end if;
    v_ate := (v_evt.payload ->> 'mensagens_ate')::timestamptz;

    select * into v_caso from public.sac_cases s
     where s.organizacao_id = v_evt.organizacao_id and s.id = (v_evt.payload ->> 'caso_id')::uuid;

    -- Execução anterior deste evento interrompida (queda com o token antigo):
    -- pode ter chamado o modelo, então continua contando no orçamento.
    update public.ai_runs r
       set status = 'falha', motivo = 'interrompida', chamou_modelo = true, concluida_em = now()
     where r.evento_outbox_id = v_evt.id and r.fencing_token < p_fencing_token and r.status = 'em_andamento';

    -- Caso que andou: uma mensagem mais nova já enfileirou outra triagem.
    if v_caso.id is null or v_caso.phase not in ('TRIAGE', 'COLLECTING_INFORMATION') or v_caso.ultima_mensagem_em > v_ate then
        if v_caso.id is null then
            perform public.concluir_tentativa_outbox(v_evt.id, p_worker_id, p_fencing_token, 'recusado', null, null, null, 'caso_inexistente', 'permanent');
            return jsonb_build_object('resultado', 'caso_inexistente');
        end if;
        insert into public.ai_runs (organizacao_id, caso_id, evento_outbox_id, fencing_token, mensagens_ate, provedor, modelo,
                                    versao_prompt, versao_schema, status, motivo, concluida_em)
        values (v_evt.organizacao_id, v_caso.id, v_evt.id, p_fencing_token, v_ate, p_provedor, p_modelo,
                p_versao_prompt, p_versao_schema, 'obsoleta', 'caso_mudou', now())
        returning id into v_run_id;
        perform public.sac_triagem_confirmar_evento(v_evt.id, p_worker_id, p_fencing_token, v_run_id);
        return jsonb_build_object('resultado', 'obsoleta', 'run_id', v_run_id);
    end if;

    -- Orçamento: execuções que chamaram (ou podem ter chamado) o modelo hoje,
    -- no dia de Brasília. Serializado por organização.
    perform pg_advisory_xact_lock(hashtextextended('ai_orcamento:' || v_evt.organizacao_id::text, 0));
    v_desde := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
    select count(*)::int into v_usadas from public.ai_runs r
     where r.organizacao_id = v_evt.organizacao_id and r.created_at >= v_desde
       and (r.status = 'em_andamento' or r.chamou_modelo);

    if v_usadas >= p_limite_diario then
        insert into public.ai_runs (organizacao_id, caso_id, evento_outbox_id, fencing_token, mensagens_ate, provedor, modelo,
                                    versao_prompt, versao_schema, status, motivo, concluida_em)
        values (v_evt.organizacao_id, v_caso.id, v_evt.id, p_fencing_token, v_ate, p_provedor, p_modelo,
                p_versao_prompt, p_versao_schema, 'handoff', 'sem_orcamento', now())
        returning id into v_run_id;
        perform public.sac_triagem_confirmar_evento(v_evt.id, p_worker_id, p_fencing_token, v_run_id);
        return jsonb_build_object('resultado', 'sem_orcamento', 'run_id', v_run_id);
    end if;

    insert into public.ai_runs (organizacao_id, caso_id, evento_outbox_id, fencing_token, mensagens_ate, provedor, modelo,
                                versao_prompt, versao_schema)
    values (v_evt.organizacao_id, v_caso.id, v_evt.id, p_fencing_token, v_ate, p_provedor, p_modelo,
            p_versao_prompt, p_versao_schema)
    returning id into v_run_id;

    -- Contexto mínimo: as últimas 5 mensagens recebidas do contato desde a que
    -- abriu o caso, cada uma cortada em 2000 caracteres. Nada do cadastro.
    select coalesce(jsonb_agg(jsonb_build_object('conteudo', x.conteudo, 'criada_em', x.created_at) order by x.created_at, x.id_local), '[]'::jsonb)
      into v_mensagens
      from (
        select left(coalesce(m.content, ''), 2000) as conteudo, m.created_at, m.id_local
          from public.chatwoot_messages m
         where m.organizacao_id = v_evt.organizacao_id
           and m.conversa_id_local = v_caso.conversa_id_local
           and m.message_type = 'incoming' and m.sender_type = 'contact'
           and m.created_at >= coalesce(
               (select o.created_at from public.chatwoot_messages o
                 where o.organizacao_id = v_evt.organizacao_id and o.id_local = v_caso.mensagem_origem_id_local),
               v_caso.created_at)
         order by m.created_at desc, m.id_local desc
         limit 5
      ) x;

    return jsonb_build_object('resultado', 'iniciada', 'run_id', v_run_id, 'mensagens', v_mensagens);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Conclusão: desfecho, revalidação da versão e evento, numa transação.
-- ---------------------------------------------------------------------------
create or replace function public.concluir_triagem_sac(
    p_run_id           uuid,
    p_worker_id        text,
    p_fencing_token    bigint,
    p_status           text,
    p_motivo           text,
    p_resultado        jsonb,
    p_chamou_modelo    boolean,
    p_tokens_entrada   integer,
    p_tokens_saida     integer,
    p_reparos          smallint,
    p_latencia_ms      integer,
    p_retry_delay_sec  integer default 30
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_run     public.ai_runs;
    v_evt     public.outbox_eventos;
    v_caso    public.sac_cases;
    v_status  text := p_status;
    v_motivo  text := p_motivo;
    v_evento  text;
begin
    if p_status is null or p_status not in ('concluida', 'handoff', 'falha') then
        raise exception 'MSG-013: desfecho de triagem invalido.' using errcode = '22023';
    end if;

    select * into v_run from public.ai_runs r where r.id = p_run_id for update;
    if v_run.id is null or v_run.status <> 'em_andamento' or v_run.fencing_token <> p_fencing_token then
        return 'posse_perdida';
    end if;
    v_evt := public.sac_triagem_evento_em_posse(v_run.evento_outbox_id, p_worker_id, p_fencing_token);
    if v_evt.id is null then
        return 'posse_perdida';
    end if;

    -- O caso andou enquanto o modelo pensava: o resultado fica como histórico, não como atual.
    select * into v_caso from public.sac_cases s where s.organizacao_id = v_run.organizacao_id and s.id = v_run.caso_id;
    if v_status <> 'falha'
       and (v_caso.phase not in ('TRIAGE', 'COLLECTING_INFORMATION') or v_caso.ultima_mensagem_em > v_run.mensagens_ate) then
        v_status := 'obsoleta';
        v_motivo := 'caso_mudou';
    end if;

    update public.ai_runs r
       set status = v_status,
           motivo = v_motivo,
           resultado = case when v_status in ('concluida', 'obsoleta') then p_resultado end,
           chamou_modelo = coalesce(p_chamou_modelo, true),
           tokens_entrada = p_tokens_entrada,
           tokens_saida = p_tokens_saida,
           reparos = coalesce(p_reparos, 0),
           latencia_ms = p_latencia_ms,
           concluida_em = now()
     where r.id = v_run.id;

    if v_status = 'falha' then
        v_evento := public.concluir_tentativa_outbox(
            v_evt.id, p_worker_id, p_fencing_token, 'nao_enviado', null, null, null, v_motivo,
            case when v_motivo = 'limite_do_provedor' then 'rate_limit' else 'transient' end,
            p_retry_delay_sec);
    else
        v_evento := public.sac_triagem_confirmar_evento(v_evt.id, p_worker_id, p_fencing_token, v_run.id);
    end if;
    return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Leitura para o cockpit.
-- ---------------------------------------------------------------------------
create or replace function public.ler_triagem_do_caso_sac(p_organizacao_id uuid, p_conversa_id_local uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_caso public.sac_cases;
    v_run  public.ai_runs;
    v_pendente boolean;
begin
    if p_organizacao_id is null or p_conversa_id_local is null then
        raise exception 'MSG-013: leitura de triagem invalida.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.chatwoot_conversations c
                    where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local) then
        return jsonb_build_object('resultado', 'conversa_inexistente');
    end if;

    select * into v_caso from public.sac_cases s
     where s.organizacao_id = p_organizacao_id and s.conversa_id_local = p_conversa_id_local
     order by s.created_at desc limit 1;
    if v_caso.id is null then
        return jsonb_build_object('resultado', 'sem_caso');
    end if;

    select * into v_run from public.ai_runs r
     where r.organizacao_id = p_organizacao_id and r.caso_id = v_caso.id
     order by r.created_at desc, r.id desc limit 1;

    select exists (select 1 from public.outbox_eventos o
                    where o.organizacao_id = p_organizacao_id and o.destination = 'interno'
                      and o.event_type = 'sac.triagem' and o.payload ->> 'caso_id' = v_caso.id::text
                      and o.status in ('pending', 'processing', 'failed_transient'))
      into v_pendente;

    return jsonb_build_object(
        'resultado', 'caso',
        'caso_id', v_caso.id,
        'fase', v_caso.phase,
        'pendente', v_pendente,
        'execucao', case when v_run.id is null then null else jsonb_build_object(
            'status', v_run.status,
            'motivo', v_run.motivo,
            'resultado', v_run.resultado,
            'provedor', v_run.provedor,
            'modelo', v_run.modelo,
            'versao_schema', v_run.versao_schema,
            'criada_em', v_run.created_at,
            'concluida_em', v_run.concluida_em) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Superfície: só o servidor, e só pelas funções.
-- ---------------------------------------------------------------------------
revoke all on function public.reivindicar_triagens_sac(text, integer, integer) from public, anon, authenticated;
revoke all on function public.iniciar_triagem_sac(uuid, text, bigint, integer, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.concluir_triagem_sac(uuid, text, bigint, text, text, jsonb, boolean, integer, integer, smallint, integer, integer)
    from public, anon, authenticated;
revoke all on function public.ler_triagem_do_caso_sac(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sac_triagem_evento_em_posse(uuid, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.sac_triagem_confirmar_evento(uuid, text, bigint, uuid) from public, anon, authenticated, service_role;
grant execute on function public.reivindicar_triagens_sac(text, integer, integer) to service_role;
grant execute on function public.iniciar_triagem_sac(uuid, text, bigint, integer, text, text, text, integer) to service_role;
grant execute on function public.concluir_triagem_sac(uuid, text, bigint, text, text, jsonb, boolean, integer, integer, smallint, integer, integer)
    to service_role;
grant execute on function public.ler_triagem_do_caso_sac(uuid, uuid) to service_role;

-- Autoverificação.
do $$
begin
    if not (select relrowsecurity from pg_class where oid = 'public.ai_runs'::regclass)
       or has_table_privilege('authenticated', 'public.ai_runs', 'select')
       or has_table_privilege('anon', 'public.ai_runs', 'select')
       or has_table_privilege('service_role', 'public.ai_runs', 'select')
       or has_table_privilege('service_role', 'public.ai_runs', 'insert')
       or has_function_privilege('authenticated', 'public.iniciar_triagem_sac(uuid,text,bigint,integer,text,text,text,integer)', 'execute')
       or has_function_privilege('authenticated', 'public.ler_triagem_do_caso_sac(uuid,uuid)', 'execute')
       or has_function_privilege('service_role', 'public.sac_triagem_confirmar_evento(uuid,text,bigint,uuid)', 'execute') then
        raise exception 'MSG-013: superficie da triagem exposta.';
    end if;
end;
$$;
