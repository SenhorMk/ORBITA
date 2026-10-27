-- 86_efeito_ambiguo_na_outbox.sql
-- Forward-only. MSG-007: a outbox representa o efeito ambíguo e impede o
-- retry inseguro.
--
-- ESTADO ANTERIOR (medido no laboratório com a cadeia canônica 01-85):
--   - `outbox_eventos.status` só conhece `pending`, `processing`, `sent`,
--     `failed_transient` e `dead_letter`. Não há como dizer "o pedido saiu e
--     não sabemos se o provedor aplicou".
--   - `concluir_evento_outbox` (migration 48) aceita `sent` sem recibo nenhum,
--     e o chamador classifica o erro por substring: `timeout`, `ECONNRESET` e
--     5xx viram `failed_transient`, que o claim seguinte reenvia. Num POST de
--     criação isso duplica a mensagem.
--   - O reaper (`liberar_leases_expirados_outbox`) devolve um evento em
--     `processing` com lease vencida para `failed_transient` sem saber se o
--     worker chegou a despachar.
--   - A posse da conclusão é só `lease_owner` + expiração. Um worker que reusa
--     o mesmo id depois de perder a lease é indistinguível do dono atual.
--   - `POST /api/chatwoot/send` envia inline e depois tenta marcar o evento
--     numa tabela que não existe (`eventos_outbox`): todo envio inline fica
--     `pending`, já despachado. Um consumidor ligado sobre esse backlog
--     reenviaria tudo.
--
-- O QUE MUDA:
--   1. Estados novos: `in_flight` (despacho iniciado, desfecho ainda não
--      gravado) e `unknown` (o efeito pode ter acontecido). Os quatro
--      desfechos de uma tentativa são `nao_enviado` (prova de que o
--      transporte não começou ou de que o provedor não aplicou), `recusado`,
--      `confirmado` (com recibo do provedor) e `desconhecido`.
--   2. Fencing monotônico: `fencing_token` sobe a cada entrada em
--      `processing`, imposto por gatilho, qualquer que seja a função que
--      reivindique. Iniciar o despacho e concluir exigem dono, token e lease
--      vigentes (compare-and-set sob `FOR UPDATE`).
--   3. `outbox_tentativas`: uma linha por despacho (evento + token), com o
--      desfecho e o motivo. Histórico; o navegador não lê.
--   4. Máquina de estados imposta pelo banco, inclusive para o service_role:
--        - `sent` só a partir de `in_flight` com recibo do provedor, ou de
--          `unknown` por reconciliação com recibo;
--        - `unknown` só sai por reconciliação (`sent`) ou por replay
--          autorizado depois de provada a não aplicação (`pending`);
--        - `sent` e `dead_letter` não regridem; intenção (organização, chave,
--          destino, tipo, payload) não muda.
--   5. O reaper passa a distinguir: `processing` vencido nunca despachou e
--      volta à fila; `in_flight` vencido vira `unknown`.
--   6. `registrar_evento_outbox` recusa reusar a chave com outra intenção
--      (`23505`), em vez de devolver o evento antigo como se fosse o mesmo.
--   7. As funções legadas `concluir_evento_outbox` e `reivindicar_lote_outbox`
--      saem: uma conclusão sem token e sem recibo não pode mais ser chamada.
--   8. Backfill: `sent` antigo ganha `confirmacao = 'legado_pre_msg007'`
--      (com o id da resposta quando ela o trouxe; nada é inventado). Envio
--      inline do Chatwoot ainda `pending`/`processing`/`failed_transient`
--      vira `unknown` com motivo `envio_inline_legado`.
--
-- O QUE NÃO MUDA: grants de tabela de `outbox_eventos`, a policy de leitura
-- por membership, o índice de idempotência, a correlação e a saúde da conexão.
--
-- RECUPERAÇÃO: forward-only. Nunca mapear `unknown` para `pending` numa
-- reversão: é exatamente o retry inseguro que esta migration fecha. Ver
-- docs/operations/msg-007-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Colunas novas.
-- ---------------------------------------------------------------------------
alter table public.outbox_eventos
    add column if not exists fencing_token        bigint not null default 0,
    add column if not exists despachado_em        timestamptz,
    add column if not exists recibo_ref           text,
    add column if not exists confirmacao          text,
    add column if not exists motivo_bloqueio      text,
    add column if not exists desconhecido_em      timestamptz,
    add column if not exists resolucao            text,
    add column if not exists resolvido_por        uuid references auth.users(id) on delete set null,
    add column if not exists resolvido_em         timestamptz,
    add column if not exists evidencia_resolucao  text,
    add column if not exists replay_autorizado_por uuid references auth.users(id) on delete set null,
    add column if not exists replay_autorizado_em timestamptz;

-- Reaplicável na mesma transação (o teste de backfill reaplica o arquivo):
-- gatilho e constraints desta migration saem antes do backfill e voltam
-- depois dele.
drop trigger if exists tg_outbox_eventos_transicao on public.outbox_eventos;
alter table public.outbox_eventos
    drop constraint if exists ck_outbox_eventos_status,
    drop constraint if exists ck_outbox_eventos_fencing_token,
    drop constraint if exists ck_outbox_eventos_confirmacao,
    drop constraint if exists ck_outbox_eventos_sent_confirmado,
    drop constraint if exists ck_outbox_eventos_recibo_ref,
    drop constraint if exists ck_outbox_eventos_motivo_bloqueio,
    drop constraint if exists ck_outbox_eventos_unknown_explicado,
    drop constraint if exists ck_outbox_eventos_em_voo,
    drop constraint if exists ck_outbox_eventos_resolucao,
    drop constraint if exists ck_outbox_eventos_evidencia;

-- O CHECK de status da migration 31 nasceu sem nome explícito.
do $$
declare
    v_nome text;
begin
    for v_nome in
        select c.conname
          from pg_constraint c
         where c.conrelid = 'public.outbox_eventos'::regclass
           and c.contype = 'c'
           and pg_get_constraintdef(c.oid) like '%status%'
           and pg_get_constraintdef(c.oid) like '%dead_letter%'
           and pg_get_constraintdef(c.oid) not like '%in_flight%'
    loop
        execute format('alter table public.outbox_eventos drop constraint %I', v_nome);
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Backfill antes das constraints e do gatilho.
-- ---------------------------------------------------------------------------
update public.outbox_eventos
   set confirmacao = 'legado_pre_msg007',
       recibo_ref = nullif(left(response_body ->> 'id', 200), '')
 where status = 'sent'
   and confirmacao is null;

-- Envio inline do Chatwoot: a rota despacha antes de marcar, e a marcação
-- nunca funcionou. Qualquer um desses pode ter chegado ao cliente.
update public.outbox_eventos
   set status = 'unknown',
       motivo_bloqueio = 'envio_inline_legado',
       desconhecido_em = now(),
       lease_owner = null,
       lease_expires_at = null
 where destination = 'chatwoot'
   and event_type = 'message.send'
   and status in ('pending', 'processing', 'failed_transient');

-- ---------------------------------------------------------------------------
-- 3. Constraints.
-- ---------------------------------------------------------------------------
alter table public.outbox_eventos
    add constraint ck_outbox_eventos_status
        check (status in ('pending', 'processing', 'in_flight', 'sent', 'failed_transient', 'dead_letter', 'unknown')),
    add constraint ck_outbox_eventos_fencing_token check (fencing_token >= 0),
    add constraint ck_outbox_eventos_confirmacao
        check (confirmacao is null or confirmacao in ('recibo_provider', 'reconciliacao', 'legado_pre_msg007')),
    -- Nunca `sent` sem confirmação; confirmação nova sempre com recibo.
    add constraint ck_outbox_eventos_sent_confirmado
        check ((status = 'sent') = (confirmacao is not null)
               and (confirmacao is null or confirmacao = 'legado_pre_msg007' or recibo_ref is not null)),
    add constraint ck_outbox_eventos_recibo_ref
        check (recibo_ref is null or char_length(recibo_ref) between 1 and 200),
    add constraint ck_outbox_eventos_motivo_bloqueio
        check (motivo_bloqueio is null or motivo_bloqueio in (
            'timeout', 'ack_perdido', 'resposta_invalida', 'erro_do_provedor', 'limite_sem_prova',
            'falha_apos_despacho', 'lease_expirada_em_voo', 'envio_inline_legado')),
    add constraint ck_outbox_eventos_unknown_explicado
        check ((status = 'unknown') = (motivo_bloqueio is not null and desconhecido_em is not null)),
    add constraint ck_outbox_eventos_em_voo
        check (status <> 'in_flight'
               or (despachado_em is not null and lease_owner is not null
                   and lease_expires_at is not null and fencing_token > 0)),
    add constraint ck_outbox_eventos_resolucao
        check (resolucao is null
               or (status = 'unknown' and resolucao in ('provado_nao_aplicado', 'revisao_manual')
                   and resolvido_por is not null and resolvido_em is not null)),
    add constraint ck_outbox_eventos_evidencia
        check (evidencia_resolucao is null or char_length(evidencia_resolucao) between 1 and 500);

-- Alvo da FK composta de `outbox_tentativas`: uma tentativa nunca aponta para
-- evento de outra organização.
create unique index if not exists uq_outbox_eventos_org_id
    on public.outbox_eventos (organizacao_id, id);

create index if not exists idx_outbox_eventos_lease_em_voo
    on public.outbox_eventos (lease_expires_at)
    where status = 'in_flight';

create index if not exists idx_outbox_eventos_atencao
    on public.outbox_eventos (organizacao_id, updated_at desc)
    where status in ('unknown', 'dead_letter', 'in_flight');

-- ---------------------------------------------------------------------------
-- 4. Tentativas.
-- ---------------------------------------------------------------------------
create table if not exists public.outbox_tentativas (
    id              uuid primary key default gen_random_uuid(),
    organizacao_id  uuid not null references public.organizacoes(id) on delete cascade,
    evento_id       uuid not null,
    fencing_token   bigint not null check (fencing_token > 0),
    worker_id       text not null check (char_length(worker_id) between 1 and 200),
    desfecho        text not null default 'em_voo'
                    check (desfecho in ('em_voo', 'confirmado', 'recusado', 'nao_enviado', 'desconhecido')),
    -- Código curto, nunca texto do provedor.
    motivo          text check (motivo ~ '^[a-z0-9_]{1,64}$'),
    recibo_ref      text check (recibo_ref is null or char_length(recibo_ref) between 1 and 200),
    iniciada_em     timestamptz not null default now(),
    concluida_em    timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint fk_outbox_tentativas_evento
        foreign key (organizacao_id, evento_id) references public.outbox_eventos (organizacao_id, id) on delete cascade,
    constraint uq_outbox_tentativas_evento_token unique (evento_id, fencing_token),
    constraint ck_outbox_tentativas_conclusao
        check ((desfecho = 'em_voo') = (concluida_em is null)),
    constraint ck_outbox_tentativas_confirmada_tem_recibo
        check (desfecho <> 'confirmado' or recibo_ref is not null)
);

create index if not exists idx_outbox_tentativas_org_evento
    on public.outbox_tentativas (organizacao_id, evento_id, fencing_token desc);

-- Só o servidor lê e escreve; sem DELETE: tentativa é histórico.
revoke all on public.outbox_tentativas from public, anon, authenticated;
grant select, insert, update on public.outbox_tentativas to service_role;
alter table public.outbox_tentativas enable row level security;

drop trigger if exists tg_outbox_tentativas_updated_at on public.outbox_tentativas;
create trigger tg_outbox_tentativas_updated_at
    before update on public.outbox_tentativas
    for each row execute function public.fn_set_updated_at();

create or replace function public.fn_outbox_tentativa_transicao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.organizacao_id is distinct from old.organizacao_id
       or new.evento_id is distinct from old.evento_id
       or new.fencing_token is distinct from old.fencing_token
       or new.worker_id is distinct from old.worker_id
       or new.iniciada_em is distinct from old.iniciada_em then
        raise exception 'A identidade de uma tentativa da outbox e imutavel.' using errcode = '23514';
    end if;
    if old.desfecho = 'em_voo' and new.desfecho <> 'em_voo' then
        return new;
    end if;
    raise exception 'Transicao invalida de tentativa da outbox: % -> %.', old.desfecho, new.desfecho
        using errcode = '23514';
end;
$$;

revoke all on function public.fn_outbox_tentativa_transicao() from public, anon, authenticated;

drop trigger if exists tg_outbox_tentativas_transicao on public.outbox_tentativas;
create trigger tg_outbox_tentativas_transicao
    before update on public.outbox_tentativas
    for each row execute function public.fn_outbox_tentativa_transicao();

-- ---------------------------------------------------------------------------
-- 5. Máquina de estados do evento, imposta pelo banco.
--
-- Vale para o service_role e para qualquer função, inclusive uma versão
-- antiga reaplicada: o gatilho é que sobe o fencing token na reivindicação.
-- ---------------------------------------------------------------------------
create or replace function public.fn_outbox_evento_transicao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.organizacao_id is distinct from old.organizacao_id
       or new.idempotency_key is distinct from old.idempotency_key
       or new.destination is distinct from old.destination
       or new.event_type is distinct from old.event_type
       or new.payload is distinct from old.payload
       or new.created_at is distinct from old.created_at then
        raise exception 'A intencao de um evento da outbox e imutavel.' using errcode = '23514';
    end if;
    if new.fencing_token < old.fencing_token then
        raise exception 'O fencing token da outbox nao regride.' using errcode = '23514';
    end if;

    -- Reivindicação: novo dono, novo token.
    if new.status = 'processing' and old.status is distinct from 'processing' then
        if old.status not in ('pending', 'failed_transient') then
            raise exception 'Evento % da outbox nao e reivindicavel.', old.status using errcode = '23514';
        end if;
        new.fencing_token := old.fencing_token + 1;
        return new;
    end if;

    if new.status = old.status then
        if new.fencing_token <> old.fencing_token then
            raise exception 'O fencing token so muda na reivindicacao.' using errcode = '23514';
        end if;
        if old.status = 'sent'
           and (new.confirmacao is distinct from old.confirmacao
                or new.recibo_ref is distinct from old.recibo_ref
                or new.sent_at is distinct from old.sent_at) then
            raise exception 'Um envio confirmado nao muda.' using errcode = '23514';
        end if;
        if old.status = 'unknown'
           and (new.motivo_bloqueio is distinct from old.motivo_bloqueio
                or new.desconhecido_em is distinct from old.desconhecido_em) then
            raise exception 'O motivo de um efeito desconhecido nao muda.' using errcode = '23514';
        end if;
        return new;
    end if;

    if new.fencing_token <> old.fencing_token then
        raise exception 'O fencing token so muda na reivindicacao.' using errcode = '23514';
    end if;

    -- Despacho iniciado pelo dono da reivindicação.
    if old.status = 'processing' and new.status = 'in_flight' then
        return new;
    end if;
    -- Nunca despachou: volta à fila ou é recusado.
    if old.status = 'processing' and new.status in ('failed_transient', 'dead_letter') then
        return new;
    end if;
    if old.status = 'pending' and new.status = 'dead_letter' then
        return new;
    end if;
    -- Desfecho do despacho.
    if old.status = 'in_flight' and new.status = 'sent' and new.confirmacao = 'recibo_provider' then
        return new;
    end if;
    if old.status = 'in_flight' and new.status in ('failed_transient', 'dead_letter', 'unknown') then
        return new;
    end if;
    -- Saídas de `unknown`: reconciliação com recibo, ou replay autorizado
    -- depois de provada a não aplicação.
    if old.status = 'unknown' and new.status = 'sent' and new.confirmacao = 'reconciliacao' then
        return new;
    end if;
    if old.status = 'unknown' and new.status = 'pending'
       and old.resolucao = 'provado_nao_aplicado'
       and new.replay_autorizado_por is not null
       and new.replay_autorizado_em is distinct from old.replay_autorizado_em then
        return new;
    end if;

    raise exception 'Transicao invalida de evento da outbox: % -> %.', old.status, new.status
        using errcode = '23514';
end;
$$;

revoke all on function public.fn_outbox_evento_transicao() from public, anon, authenticated;

drop trigger if exists tg_outbox_eventos_transicao on public.outbox_eventos;
create trigger tg_outbox_eventos_transicao
    before update on public.outbox_eventos
    for each row execute function public.fn_outbox_evento_transicao();

-- ---------------------------------------------------------------------------
-- 6. Funções legadas: conclusão sem token e sem recibo, claim sem token.
-- ---------------------------------------------------------------------------
drop function if exists public.concluir_evento_outbox(uuid, text, text, jsonb, text, text, integer);
drop function if exists public.reivindicar_lote_outbox(text, integer, integer);

-- ---------------------------------------------------------------------------
-- 7. Registro: mesma chave, mesma intenção — ou 23505.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_evento_outbox(
    p_organizacao_id   uuid,
    p_conexao_id       uuid,
    p_user_id          uuid,
    p_idempotency_key  text,
    p_destination      text,
    p_event_type       text,
    p_payload          jsonb,
    p_max_attempts     integer default 5
)
returns table (
    evento_id     uuid,
    status        text,
    is_duplicate  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existente record;
    v_new_id    uuid;
begin
    insert into public.outbox_eventos (
        organizacao_id, conexao_id, user_id, idempotency_key, destination,
        event_type, payload, status, max_attempts, next_retry_at
    ) values (
        p_organizacao_id, p_conexao_id, p_user_id, p_idempotency_key, p_destination,
        p_event_type, p_payload, 'pending', coalesce(p_max_attempts, 5), now()
    )
    on conflict (organizacao_id, idempotency_key) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
        return query select v_new_id, 'pending'::text, false;
        return;
    end if;

    select o.id, o.status, o.destination, o.event_type, o.payload into v_existente
      from public.outbox_eventos o
     where o.organizacao_id = p_organizacao_id
       and o.idempotency_key = p_idempotency_key;

    if v_existente.destination is distinct from p_destination
       or v_existente.event_type is distinct from p_event_type
       or v_existente.payload is distinct from p_payload then
        raise exception 'idempotency_key da outbox reutilizada com outra intencao.' using errcode = '23505';
    end if;

    return query select v_existente.id, v_existente.status, true;
end;
$$;

revoke all on function public.registrar_evento_outbox(uuid, uuid, uuid, text, text, text, jsonb, integer)
    from public, anon, authenticated;
grant execute on function public.registrar_evento_outbox(uuid, uuid, uuid, text, text, text, jsonb, integer)
    to service_role;

-- ---------------------------------------------------------------------------
-- 8. Reivindicação em lote (worker) e de um evento (envio inline).
-- ---------------------------------------------------------------------------
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

create or replace function public.reivindicar_evento_outbox(
    p_organizacao_id  uuid,
    p_evento_id       uuid,
    p_worker_id       text,
    p_lease_ttl_sec   integer default 60
)
returns table (fencing_token bigint, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_worker_id is null or char_length(trim(p_worker_id)) = 0 or char_length(p_worker_id) > 200 then
        raise exception 'p_worker_id invalido.' using errcode = '22023';
    end if;
    if p_lease_ttl_sec is null or p_lease_ttl_sec < 5 or p_lease_ttl_sec > 3600 then
        raise exception 'p_lease_ttl_sec fora de 5..3600.' using errcode = '22023';
    end if;

    return query
    update public.outbox_eventos o
       set status = 'processing',
           lease_owner = p_worker_id,
           lease_expires_at = now() + make_interval(secs => p_lease_ttl_sec),
           updated_at = now()
     where o.id = p_evento_id
       and o.organizacao_id = p_organizacao_id
       and o.status in ('pending', 'failed_transient')
       and o.next_retry_at <= now()
    returning o.fencing_token, o.lease_expires_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Início do despacho: o último passo antes da rede.
-- ---------------------------------------------------------------------------
create or replace function public.iniciar_despacho_outbox(
    p_evento_id      uuid,
    p_worker_id      text,
    p_fencing_token  bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_evt record;
begin
    select * into v_evt from public.outbox_eventos where id = p_evento_id for update;
    if not found
       or v_evt.status <> 'processing'
       or v_evt.lease_owner is distinct from p_worker_id
       or v_evt.fencing_token is distinct from p_fencing_token
       or v_evt.lease_expires_at is null
       or v_evt.lease_expires_at < now() then
        return false;
    end if;

    update public.outbox_eventos
       set status = 'in_flight', despachado_em = now(), updated_at = now()
     where id = p_evento_id;

    insert into public.outbox_tentativas (organizacao_id, evento_id, fencing_token, worker_id)
    values (v_evt.organizacao_id, v_evt.id, v_evt.fencing_token, p_worker_id);
    return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Conclusão por compare-and-set de dono, token e lease.
--
-- Devolve o status gravado, ou null quando a posse não é mais do chamador
-- (lease vencida, outro dono, token antigo): nada muda nesse caso.
-- `processing` (nunca despachou) só aceita `nao_enviado` ou `recusado`.
-- ---------------------------------------------------------------------------
create or replace function public.concluir_tentativa_outbox(
    p_evento_id        uuid,
    p_worker_id        text,
    p_fencing_token    bigint,
    p_desfecho         text,
    p_recibo_ref       text default null,
    p_resposta         jsonb default null,
    p_motivo           text default null,
    p_erro             text default null,
    p_categoria        text default null,
    p_retry_delay_sec  integer default 10
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_evt record;
    v_tentativas integer;
    v_status text;
    v_erro text := left(p_erro, 500);
    v_delay integer := least(greatest(coalesce(p_retry_delay_sec, 10), 1), 86400);
begin
    if p_desfecho is null or p_desfecho not in ('confirmado', 'nao_enviado', 'recusado', 'desconhecido') then
        raise exception 'Desfecho de outbox invalido.' using errcode = '22023';
    end if;
    if p_desfecho = 'confirmado' and (p_recibo_ref is null or char_length(trim(p_recibo_ref)) = 0) then
        raise exception 'Confirmacao de outbox exige recibo do provedor.' using errcode = '22023';
    end if;
    if p_desfecho = 'desconhecido' and p_motivo is null then
        raise exception 'Efeito desconhecido exige motivo.' using errcode = '22023';
    end if;
    if p_categoria is not null and p_categoria not in ('transient', 'permanent', 'rate_limit', 'auth_expired') then
        raise exception 'Categoria de erro de outbox invalida.' using errcode = '22023';
    end if;

    select * into v_evt from public.outbox_eventos where id = p_evento_id for update;
    if not found
       or v_evt.status not in ('processing', 'in_flight')
       or v_evt.lease_owner is distinct from p_worker_id
       or v_evt.fencing_token is distinct from p_fencing_token
       or v_evt.lease_expires_at is null
       or v_evt.lease_expires_at < now() then
        return null;
    end if;
    if v_evt.status = 'processing' and p_desfecho in ('confirmado', 'desconhecido') then
        raise exception 'Evento sem despacho iniciado nao pode ser %.', p_desfecho using errcode = '22023';
    end if;

    v_tentativas := v_evt.attempts + 1;

    if p_desfecho = 'confirmado' then
        v_status := 'sent';
        update public.outbox_eventos
           set status = 'sent', confirmacao = 'recibo_provider', recibo_ref = left(trim(p_recibo_ref), 200),
               response_body = p_resposta, last_error = null, last_error_category = null,
               sent_at = now(), attempts = v_tentativas,
               lease_owner = null, lease_expires_at = null, updated_at = now()
         where id = p_evento_id;
    elsif p_desfecho = 'desconhecido' then
        v_status := 'unknown';
        update public.outbox_eventos
           set status = 'unknown', motivo_bloqueio = p_motivo, desconhecido_em = now(),
               last_error = v_erro, last_error_category = p_categoria, attempts = v_tentativas,
               lease_owner = null, lease_expires_at = null, updated_at = now()
         where id = p_evento_id;
    elsif p_desfecho = 'recusado' or v_tentativas >= v_evt.max_attempts then
        v_status := 'dead_letter';
        update public.outbox_eventos
           set status = 'dead_letter', last_error = v_erro,
               last_error_category = coalesce(p_categoria, 'permanent'), attempts = v_tentativas,
               lease_owner = null, lease_expires_at = null, updated_at = now()
         where id = p_evento_id;
    else
        v_status := 'failed_transient';
        update public.outbox_eventos
           set status = 'failed_transient', last_error = v_erro,
               last_error_category = coalesce(p_categoria, 'transient'), attempts = v_tentativas,
               next_retry_at = now() + make_interval(secs => v_delay),
               lease_owner = null, lease_expires_at = null, updated_at = now()
         where id = p_evento_id;
    end if;

    if v_evt.status = 'in_flight' then
        update public.outbox_tentativas
           set desfecho = p_desfecho, motivo = p_motivo,
               recibo_ref = case when p_desfecho = 'confirmado' then left(trim(p_recibo_ref), 200) end,
               concluida_em = now()
         where evento_id = p_evento_id and fencing_token = p_fencing_token;
    end if;

    if v_evt.conexao_id is not null then
        update public.conexoes_integracao
           set health_status = case
                   when v_status = 'sent' then 'healthy'
                   when p_categoria = 'auth_expired' then 'disconnected'
                   when v_status = 'dead_letter' then 'error'
                   else 'degraded' end,
               last_health_error = case when v_status = 'sent' then null else v_erro end,
               last_health_check_at = now()
         where id = v_evt.conexao_id and organizacao_id = v_evt.organizacao_id;
    end if;

    return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Reaper: `processing` vencido nunca despachou; `in_flight` vencido pode
-- ter despachado e vira `unknown`.
-- ---------------------------------------------------------------------------
create or replace function public.liberar_leases_expirados_outbox()
returns table (
    evento_id       uuid,
    novo_status     text
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row record;
    v_new_attempts integer;
    v_new_status text;
begin
    for v_row in
        select *
          from public.outbox_eventos
         where status in ('processing', 'in_flight')
           and lease_expires_at is not null
           and lease_expires_at < now()
         for update skip locked
    loop
        v_new_attempts := v_row.attempts + 1;
        if v_row.status = 'in_flight' then
            v_new_status := 'unknown';
            update public.outbox_eventos
               set status = 'unknown', motivo_bloqueio = 'lease_expirada_em_voo', desconhecido_em = now(),
                   attempts = v_new_attempts,
                   last_error = 'Lease expirada com despacho iniciado: o efeito pode ter acontecido.',
                   last_error_category = 'transient',
                   lease_owner = null, lease_expires_at = null, updated_at = now()
             where id = v_row.id;
            update public.outbox_tentativas t
               set desfecho = 'desconhecido', motivo = 'lease_expirada_em_voo', concluida_em = now()
             where t.evento_id = v_row.id and t.fencing_token = v_row.fencing_token and t.desfecho = 'em_voo';
        elsif v_new_attempts >= v_row.max_attempts then
            v_new_status := 'dead_letter';
            update public.outbox_eventos
               set status = 'dead_letter', attempts = v_new_attempts,
                   last_error = coalesce(last_error, 'Lease expirado: worker encerrado inesperadamente.'),
                   last_error_category = coalesce(last_error_category, 'transient'),
                   lease_owner = null, lease_expires_at = null, updated_at = now()
             where id = v_row.id;
        else
            v_new_status := 'failed_transient';
            update public.outbox_eventos
               set status = 'failed_transient', attempts = v_new_attempts,
                   last_error = 'Lease expirado: worker encerrado inesperadamente.',
                   last_error_category = 'transient', next_retry_at = now(),
                   lease_owner = null, lease_expires_at = null, updated_at = now()
             where id = v_row.id;
        end if;

        evento_id := v_row.id;
        novo_status := v_new_status;
        return next;
    end loop;
    return;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Decisões humanas sobre `unknown`. A organização e o ator chegam do
-- escopo verificado no servidor; a função ainda confere o papel.
-- Erros: 42501 sem papel, P0002 evento fora da organização, 55000 estado que
-- não admite a decisão, 22023 entrada inválida.
-- ---------------------------------------------------------------------------
create or replace function public.resolver_evento_desconhecido_outbox(
    p_organizacao_id  uuid,
    p_evento_id       uuid,
    p_ator_id         uuid,
    p_resolucao       text,
    p_recibo_ref      text default null,
    p_evidencia       text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_evt record;
    v_evidencia text := nullif(trim(p_evidencia), '');
begin
    if not exists (select 1 from public.membros_organizacao m
                    where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id
                      and m.papel in ('owner', 'admin')) then
        raise exception 'Ator sem papel para reconciliar a outbox.' using errcode = '42501';
    end if;
    if p_resolucao is null or p_resolucao not in ('confirmado', 'provado_nao_aplicado', 'revisao_manual') then
        raise exception 'Resolucao invalida.' using errcode = '22023';
    end if;
    if p_resolucao = 'confirmado' and (p_recibo_ref is null or char_length(trim(p_recibo_ref)) = 0) then
        raise exception 'Confirmar exige a referencia exata do provedor.' using errcode = '22023';
    end if;
    if p_resolucao = 'provado_nao_aplicado' and (v_evidencia is null or char_length(v_evidencia) < 10) then
        raise exception 'Provar nao aplicacao exige evidencia.' using errcode = '22023';
    end if;
    if v_evidencia is not null and char_length(v_evidencia) > 500 then
        raise exception 'Evidencia acima de 500 caracteres.' using errcode = '22023';
    end if;

    select * into v_evt from public.outbox_eventos
     where id = p_evento_id and organizacao_id = p_organizacao_id
       for update;
    if not found then
        raise exception 'Evento da outbox nao encontrado.' using errcode = 'P0002';
    end if;
    if v_evt.status <> 'unknown' then
        raise exception 'Evento da outbox em % nao e reconciliavel.', v_evt.status using errcode = '55000';
    end if;

    if p_resolucao = 'confirmado' then
        update public.outbox_eventos
           set status = 'sent', confirmacao = 'reconciliacao', recibo_ref = left(trim(p_recibo_ref), 200),
               sent_at = now(), motivo_bloqueio = null, desconhecido_em = null, resolucao = null,
               resolvido_por = p_ator_id, resolvido_em = now(), evidencia_resolucao = v_evidencia,
               updated_at = now()
         where id = p_evento_id;
        return 'sent';
    end if;

    update public.outbox_eventos
       set resolucao = p_resolucao, resolvido_por = p_ator_id, resolvido_em = now(),
           evidencia_resolucao = v_evidencia, updated_at = now()
     where id = p_evento_id;
    return 'unknown';
end;
$$;

create or replace function public.autorizar_replay_outbox(
    p_organizacao_id  uuid,
    p_evento_id       uuid,
    p_ator_id         uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_evt record;
begin
    if not exists (select 1 from public.membros_organizacao m
                    where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id
                      and m.papel in ('owner', 'admin')) then
        raise exception 'Ator sem papel para autorizar replay da outbox.' using errcode = '42501';
    end if;

    select * into v_evt from public.outbox_eventos
     where id = p_evento_id and organizacao_id = p_organizacao_id
       for update;
    if not found then
        raise exception 'Evento da outbox nao encontrado.' using errcode = 'P0002';
    end if;
    if v_evt.status <> 'unknown' or v_evt.resolucao is distinct from 'provado_nao_aplicado' then
        raise exception 'Replay inelegivel: o efeito nao foi provado como nao aplicado.' using errcode = '55000';
    end if;

    update public.outbox_eventos
       set status = 'pending', next_retry_at = now(),
           motivo_bloqueio = null, desconhecido_em = null, resolucao = null,
           replay_autorizado_por = p_ator_id, replay_autorizado_em = clock_timestamp(),
           updated_at = now()
     where id = p_evento_id;
    return 'pending';
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Privilégios: só o servidor.
-- ---------------------------------------------------------------------------
revoke all on function public.reivindicar_tentativas_outbox(text, integer, integer) from public, anon, authenticated;
revoke all on function public.reivindicar_evento_outbox(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.iniciar_despacho_outbox(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.concluir_tentativa_outbox(uuid, text, bigint, text, text, jsonb, text, text, text, integer)
    from public, anon, authenticated;
revoke all on function public.liberar_leases_expirados_outbox() from public, anon, authenticated;
revoke all on function public.resolver_evento_desconhecido_outbox(uuid, uuid, uuid, text, text, text)
    from public, anon, authenticated;
revoke all on function public.autorizar_replay_outbox(uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.reivindicar_tentativas_outbox(text, integer, integer) to service_role;
grant execute on function public.reivindicar_evento_outbox(uuid, uuid, text, integer) to service_role;
grant execute on function public.iniciar_despacho_outbox(uuid, text, bigint) to service_role;
grant execute on function public.concluir_tentativa_outbox(uuid, text, bigint, text, text, jsonb, text, text, text, integer)
    to service_role;
grant execute on function public.liberar_leases_expirados_outbox() to service_role;
grant execute on function public.resolver_evento_desconhecido_outbox(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.autorizar_replay_outbox(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 14. Eventos de auditoria (projeção SQL de `auditEventCatalog.ts`).
-- Metadata: ids técnicos, destino, motivo e desfecho; nunca o payload.
-- ---------------------------------------------------------------------------
insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('outbox.effect_unknown', 1, 'integrations', 'critical', 'system', 1825, null,
     'Efeito externo sem confirmação: pode ter acontecido; bloqueado para retry até reconciliar.'),
    ('outbox.effect_reconciled', 1, 'integrations', 'warning', 'user', 1825, null,
     'Efeito desconhecido reconciliado por pessoa autorizada.'),
    ('outbox.replay_authorized', 1, 'integrations', 'warning', 'user', 1825, null,
     'Replay autorizado de efeito provado como não aplicado.'),
    ('outbox.replay_refused', 1, 'integrations', 'info', 'user', 1825, null,
     'Pedido de replay recusado: efeito sem prova de não aplicação.')
on conflict (nome) do nothing;

-- ---------------------------------------------------------------------------
-- Autoverificação.
-- ---------------------------------------------------------------------------
do $$
declare
    v_texto text;
begin
    select count(*)::text into v_texto
      from public.outbox_eventos
     where destination = 'chatwoot' and event_type = 'message.send'
       and status in ('pending', 'processing', 'failed_transient');
    if v_texto <> '0' then
        raise exception 'MSG-007: % envio(s) inline do Chatwoot ainda elegiveis para retry', v_texto;
    end if;

    select string_agg(t.tabela || ':' || r.rolname, ', ') into v_texto
      from (values ('public.outbox_eventos'), ('public.outbox_tentativas')) as t(tabela)
     cross join (values ('authenticated'), ('anon')) as r(rolname)
     where has_table_privilege(r.rolname, t.tabela, 'INSERT')
        or has_table_privilege(r.rolname, t.tabela, 'UPDATE')
        or has_table_privilege(r.rolname, t.tabela, 'DELETE')
        or has_table_privilege(r.rolname, t.tabela, 'TRUNCATE')
        or (t.tabela = 'public.outbox_tentativas' and has_table_privilege(r.rolname, t.tabela, 'SELECT'));
    if v_texto is not null then
        raise exception 'MSG-007: o navegador escreve na outbox ou le tentativas (%)', v_texto;
    end if;

    select p.oid::regprocedure::text into v_texto
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('reivindicar_tentativas_outbox', 'reivindicar_evento_outbox', 'iniciar_despacho_outbox',
                         'concluir_tentativa_outbox', 'liberar_leases_expirados_outbox',
                         'resolver_evento_desconhecido_outbox', 'autorizar_replay_outbox',
                         'registrar_evento_outbox', 'fn_outbox_evento_transicao', 'fn_outbox_tentativa_transicao')
       and (has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('anon', p.oid, 'execute'))
     limit 1;
    if v_texto is not null then
        raise exception 'MSG-007: o navegador executa %', v_texto;
    end if;

    if to_regprocedure('public.concluir_evento_outbox(uuid,text,text,jsonb,text,text,integer)') is not null
       or to_regprocedure('public.reivindicar_lote_outbox(text,integer,integer)') is not null then
        raise exception 'MSG-007: funcao legada de conclusao/claim sem fencing ainda existe';
    end if;

    select t.tgname into v_texto
      from (values ('public.outbox_eventos', 'tg_outbox_eventos_transicao'),
                   ('public.outbox_tentativas', 'tg_outbox_tentativas_transicao')) as t(tabela, tgname)
     where not exists (select 1 from pg_trigger g
                        where g.tgrelid = t.tabela::regclass and g.tgname = t.tgname and g.tgenabled = 'O')
     limit 1;
    if v_texto is not null then
        raise exception 'MSG-007: gatilho % ausente ou desligado', v_texto;
    end if;

    raise notice 'MSG-007: outbox com efeito ambiguo; unknown=%',
        (select count(*) from public.outbox_eventos where status = 'unknown');
end;
$$;

notify pgrst, 'reload schema';
