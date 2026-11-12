-- 91_controle_atendimento_chatwoot.sql
-- Forward-only. MSG-009: quem responde a conversa (automação ou atendente), com
-- versão, histórico e nota privada.
--
-- ESTADO ANTERIOR (cadeia 01-90, main `3d62493`):
--   - Nada diz quem responde uma conversa: qualquer membro registra um envio a
--     qualquer momento, e um envio na fila sai mesmo depois que outra pessoa
--     passou a cuidar da conversa.
--   - O worker de envio inicia o despacho só pela posse do evento
--     (`iniciar_despacho_outbox`), sem conferir nada da conversa.
--
-- O QUE MUDA:
--   1. `chatwoot_conversa_controle`: `ownership_mode` (AI, HUMAN_REQUIRED,
--      HUMAN), `wait_reason`, responsável e `control_version`. Sem linha, a
--      conversa está em HUMAN_REQUIRED, versão 0 (a linha nasce na 1ª ação).
--   2. `chatwoot_controle_historico`: cada mudança, com `command_id`, ator,
--      versão resultante e a nota privada. Única por organização + comando.
--   3. `chatwoot_envios`: `controle_versao` (a versão do controle quando o envio
--      foi registrado), `privada` (nota privada do Chatwoot) e `invalidado_em`.
--   4. `alterar_controle_atendimento_chatwoot`: assumir, devolver à automação e
--      exigir humano, com compare-and-set na versão. Cada mudança invalida os
--      envios na fila (`pending` e `failed_transient`) e informa os que podem
--      ter chegado (`in_flight` e `unknown`).
--   5. `registrar_envio_chatwoot`: responder quando a conversa não tem dono
--      (ou o dono saiu da organização) é assumi-la; responder conversa de
--      outra pessoa é `outro_responsavel`.
--   6. `iniciar_envio_chatwoot`: antes de marcar `in_flight`, confere a versão
--      sob trava; versão vencida invalida o envio sem chamar o Chatwoot.
--      `iniciar_despacho_outbox` recusa evento de `chatwoot_envios` (55000):
--      o caminho genérico não despacha sem a conferência.
--   7. `reivindicar_envios_chatwoot` ganha `p_protocolo` (= 2) e devolve
--      `privada`: um worker anterior a esta migration falha fechado, em vez de
--      despachar nota privada como mensagem ou ignorar a versão.
--
-- O QUE NÃO MUDA: a máquina de estados da outbox (MSG-007; a invalidação de
-- `failed_transient` usa só transições que ela já admite), o consumo da inbox
-- (MSG-006) e a conclusão do envio (MSG-008), salvo que nota privada não vira
-- mensagem espelhada. Envios já registrados ficam com `controle_versao = 0`: a
-- primeira mudança de controle da conversa os invalida.
--
-- RECUPERAÇÃO: forward-only. Ver docs/operations/msg-009-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Controle da conversa.
-- ---------------------------------------------------------------------------
create table if not exists public.chatwoot_conversa_controle (
    organizacao_id     uuid not null references public.organizacoes(id) on delete cascade,
    conversa_id_local  uuid not null,
    ownership_mode     text not null default 'HUMAN_REQUIRED',
    wait_reason        text not null default 'NONE',
    -- Pessoa removida deixa a conversa sem dono: ninguém herda a autoridade.
    responsavel_id     uuid references auth.users(id) on delete set null,
    control_version    bigint not null default 0,
    updated_at         timestamptz not null default now(),
    constraint pk_chatwoot_conversa_controle primary key (organizacao_id, conversa_id_local),
    constraint ck_chatwoot_conversa_controle_modo check (ownership_mode in ('AI', 'HUMAN_REQUIRED', 'HUMAN')),
    constraint ck_chatwoot_conversa_controle_espera
        check (wait_reason in ('NONE', 'CUSTOMER', 'APPROVAL', 'PAYMENT', 'EXTERNAL')),
    constraint ck_chatwoot_conversa_controle_versao check (control_version >= 0),
    constraint ck_chatwoot_conversa_controle_dono check (ownership_mode = 'HUMAN' or responsavel_id is null),
    constraint fk_chatwoot_conversa_controle_conversa foreign key (organizacao_id, conversa_id_local)
        references public.chatwoot_conversations(organizacao_id, id_local) on delete cascade
);

create index if not exists idx_chatwoot_conversa_controle_responsavel
    on public.chatwoot_conversa_controle (responsavel_id)
    where responsavel_id is not null;

alter table public.chatwoot_conversa_controle enable row level security;
revoke all on public.chatwoot_conversa_controle from public, anon, authenticated, service_role;
grant select on public.chatwoot_conversa_controle to service_role;

-- ---------------------------------------------------------------------------
-- 2. Histórico: cada mudança, uma vez por comando.
-- ---------------------------------------------------------------------------
create table if not exists public.chatwoot_controle_historico (
    id                 uuid primary key default gen_random_uuid(),
    organizacao_id     uuid not null references public.organizacoes(id) on delete cascade,
    conversa_id_local  uuid not null,
    command_id         uuid not null,
    acao               text not null,
    comando_digest     text not null,
    modo_anterior      text not null,
    modo_novo          text not null,
    versao_resultante  bigint not null,
    ator_id            uuid references auth.users(id) on delete set null,
    -- Quem tinha a conversa antes: distingue assumir conversa livre de
    -- transferir o atendimento de outra pessoa.
    responsavel_anterior uuid references auth.users(id) on delete set null,
    -- Nota privada: fica no ORBITA mesmo quando o Chatwoot está fora.
    nota               text,
    nota_envio_id      uuid,
    invalidados        integer not null default 0,
    em_voo             integer not null default 0,
    created_at         timestamptz not null default now(),
    constraint ck_chatwoot_controle_historico_acao
        check (acao in ('assumir', 'devolver', 'exigir_humano', 'assumir_por_envio')),
    constraint ck_chatwoot_controle_historico_digest check (comando_digest ~ '^[0-9a-f]{64}$'),
    constraint ck_chatwoot_controle_historico_modos
        check (modo_anterior in ('AI', 'HUMAN_REQUIRED', 'HUMAN') and modo_novo in ('AI', 'HUMAN_REQUIRED', 'HUMAN')),
    constraint ck_chatwoot_controle_historico_versao check (versao_resultante >= 1),
    constraint ck_chatwoot_controle_historico_nota check (nota is null or char_length(nota) between 1 and 2000),
    constraint ck_chatwoot_controle_historico_contagens check (invalidados >= 0 and em_voo >= 0),
    constraint uq_chatwoot_controle_historico_comando unique (organizacao_id, command_id),
    constraint fk_chatwoot_controle_historico_conversa foreign key (organizacao_id, conversa_id_local)
        references public.chatwoot_conversations(organizacao_id, id_local) on delete cascade,
    constraint fk_chatwoot_controle_historico_nota foreign key (organizacao_id, nota_envio_id)
        references public.chatwoot_envios(organizacao_id, id) on delete set null (nota_envio_id)
);

create index if not exists idx_chatwoot_controle_historico_conversa
    on public.chatwoot_controle_historico (organizacao_id, conversa_id_local, created_at desc);
create index if not exists idx_chatwoot_controle_historico_nota
    on public.chatwoot_controle_historico (organizacao_id, nota_envio_id)
    where nota_envio_id is not null;

alter table public.chatwoot_controle_historico enable row level security;
revoke all on public.chatwoot_controle_historico from public, anon, authenticated, service_role;
grant select on public.chatwoot_controle_historico to service_role;

-- ---------------------------------------------------------------------------
-- 3. Envio: versão do controle, nota privada e invalidação.
-- ---------------------------------------------------------------------------
alter table public.chatwoot_envios add column if not exists controle_versao bigint not null default 0;
alter table public.chatwoot_envios add column if not exists privada boolean not null default false;
alter table public.chatwoot_envios add column if not exists invalidado_em timestamptz;

alter table public.chatwoot_envios drop constraint if exists ck_chatwoot_envios_controle_versao;
alter table public.chatwoot_envios
    add constraint ck_chatwoot_envios_controle_versao check (controle_versao >= 0);

create or replace function public.fn_chatwoot_envio_imutavel()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if new.id is distinct from old.id
       or new.organizacao_id is distinct from old.organizacao_id
       or new.conexao_id is distinct from old.conexao_id
       or new.conversa_id_local is distinct from old.conversa_id_local
       or new.command_id is distinct from old.command_id
       or new.payload_digest is distinct from old.payload_digest
       or new.conteudo is distinct from old.conteudo
       or new.outbox_evento_id is distinct from old.outbox_evento_id
       or new.created_at is distinct from old.created_at
       or new.controle_versao is distinct from old.controle_versao
       or new.privada is distinct from old.privada
       or (new.ator_id is distinct from old.ator_id and new.ator_id is not null) then
        raise exception 'MSG-008: a intencao de envio e imutavel.' using errcode = '23514';
    end if;
    if old.mensagem_id_local is not null and new.mensagem_id_local is distinct from old.mensagem_id_local
       and new.mensagem_id_local is not null then
        raise exception 'MSG-008: o vinculo do envio com a mensagem nao muda.' using errcode = '23514';
    end if;
    if old.invalidado_em is not null and new.invalidado_em is distinct from old.invalidado_em then
        raise exception 'MSG-009: a invalidacao do envio nao muda.' using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_chatwoot_envio_imutavel() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Trilha.
-- ---------------------------------------------------------------------------
insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('chatwoot.control_changed', 1, 'integrations', 'info', 'user', 1825, null,
     'Controle do atendimento mudou: assumido, devolvido à automação ou aguardando humano.'),
    ('chatwoot.send_invalidated', 1, 'integrations', 'warning', 'system', 1825, null,
     'Resposta na fila invalidada porque o controle do atendimento mudou antes do despacho.')
on conflict (nome) do nothing;

create or replace function public.auditar_controle_chatwoot(
    p_organizacao_id    uuid,
    p_ator_id           uuid,
    p_conversa_id_local uuid,
    p_metadata          jsonb
)
returns void
language sql
security invoker
set search_path = ''
as $$
    insert into public.eventos_auditoria_sistema (organizacao_id, actor_id, acao, recurso, recurso_id, correlation_id, metadata)
    values (p_organizacao_id, p_ator_id, 'chatwoot.control_changed', 'chatwoot_conversa', p_conversa_id_local::text, null,
            p_metadata);
$$;

-- ---------------------------------------------------------------------------
-- 5. A linha de controle, criada na primeira vez e travada.
-- ---------------------------------------------------------------------------
create or replace function public.travar_controle_chatwoot(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid,
    p_compartilhada     boolean
)
returns public.chatwoot_conversa_controle
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_controle public.chatwoot_conversa_controle;
begin
    insert into public.chatwoot_conversa_controle (organizacao_id, conversa_id_local)
    values (p_organizacao_id, p_conversa_id_local)
    on conflict (organizacao_id, conversa_id_local) do nothing;

    if p_compartilhada then
        select c.* into strict v_controle from public.chatwoot_conversa_controle c
         where c.organizacao_id = p_organizacao_id and c.conversa_id_local = p_conversa_id_local
           for share;
    else
        select c.* into strict v_controle from public.chatwoot_conversa_controle c
         where c.organizacao_id = p_organizacao_id and c.conversa_id_local = p_conversa_id_local
           for update;
    end if;
    return v_controle;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Invalidação do que está na fila, sem dono e sem efeito possível:
--   - `pending`: nunca despachou; `pending` → `dead_letter` é transição da
--     máquina da migration 86.
--   - `failed_transient`: só nasce de `nao_enviado` (prova de que o provedor
--     não aplicou) ou de `processing` vencido (nunca despachou). A máquina não
--     tem `failed_transient` → `dead_letter`; a invalidação faz o caminho que
--     ela já admite, reivindicar e recusar (`failed_transient` → `processing`
--     → `dead_letter`), na mesma transação. O gatilho sobe o fencing token na
--     reivindicação, então nenhuma posse antiga conclui depois.
-- `processing` e `in_flight` têm dono: quem está com o worker é invalidado por
-- `iniciar_envio_chatwoot`, que espera a trava do controle. `unknown` nunca é
-- tocado: o efeito pode ter acontecido. A saúde da conexão não muda.
-- Nota privada não é invalidada: ela é o registro da própria mudança.
-- ---------------------------------------------------------------------------
create or replace function public.invalidar_envios_na_fila_chatwoot(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid,
    p_versao_vigente    bigint
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_envio record;
    v_total integer := 0;
begin
    for v_envio in
        select e.id, e.outbox_evento_id, e.conexao_id, o.status
          from public.chatwoot_envios e
          join public.outbox_eventos o on o.organizacao_id = e.organizacao_id and o.id = e.outbox_evento_id
         where e.organizacao_id = p_organizacao_id
           and e.conversa_id_local = p_conversa_id_local
           and not e.privada
           and e.invalidado_em is null
           and e.controle_versao < p_versao_vigente
           and o.status in ('pending', 'failed_transient')
           for update of o, e
    loop
        if v_envio.status = 'failed_transient' then
            update public.outbox_eventos
               set status = 'processing',
                   lease_owner = 'msg009:invalidacao',
                   lease_expires_at = now(),
                   updated_at = now()
             where id = v_envio.outbox_evento_id;
        end if;
        update public.outbox_eventos
           set status = 'dead_letter',
               last_error = 'Envio invalidado: o controle do atendimento mudou antes do despacho.',
               last_error_category = 'permanent',
               lease_owner = null, lease_expires_at = null,
               updated_at = now()
         where id = v_envio.outbox_evento_id;
        update public.chatwoot_envios set invalidado_em = now() where id = v_envio.id;
        perform public.auditar_envio_chatwoot(p_organizacao_id, null, 'chatwoot.send_invalidated', v_envio.id,
            jsonb_build_object('conexao_id', v_envio.conexao_id, 'evento_id', v_envio.outbox_evento_id,
                               'versao_vigente', p_versao_vigente));
        v_total := v_total + 1;
    end loop;
    return v_total;
end;
$$;

-- Envios da conversa que podem ter chegado ao Chatwoot: `in_flight` e
-- `unknown` (inclusive o que o reaper tirou de `in_flight`), salvo o `unknown`
-- já provado não aplicado.
create or replace function public.contar_envios_em_voo_chatwoot(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid
)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
    select count(*)::integer
      from public.chatwoot_envios e
      join public.outbox_eventos o on o.organizacao_id = e.organizacao_id and o.id = e.outbox_evento_id
     where e.organizacao_id = p_organizacao_id
       and e.conversa_id_local = p_conversa_id_local
       and not e.privada
       and (o.status = 'in_flight'
            or (o.status = 'unknown' and o.resolucao is distinct from 'provado_nao_aplicado'));
$$;

-- ---------------------------------------------------------------------------
-- 7. Nota privada: uma intenção como a do envio, com `privada = true`, que o
-- worker despacha com `private: true`. Sem conexão utilizável, não há nota
-- no Chatwoot; a nota continua no histórico.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_nota_privada_chatwoot(
    p_organizacao_id    uuid,
    p_ator_id           uuid,
    p_conversa_id_local uuid,
    p_command_id        uuid,
    p_conteudo          text,
    p_controle_versao   bigint
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_conexao uuid;
    v_evento  uuid;
    v_envio   uuid;
    v_digest  text;
begin
    select c.conexao_id into v_conexao
      from public.chatwoot_conversations c
      join public.conexoes_integracao i on i.id = c.conexao_id and i.organizacao_id = c.organizacao_id
     where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local
       and i.provedor = 'chatwoot' and i.status <> 'desconectado';
    if v_conexao is null then
        return null;
    end if;

    v_digest := encode(pg_catalog.sha256(convert_to(p_conversa_id_local::text || chr(10) || p_conteudo, 'UTF8')), 'hex');

    select r.evento_id into v_evento
      from public.registrar_evento_outbox(
          p_organizacao_id, v_conexao, p_ator_id,
          'chatwoot.message.note:' || p_command_id::text, 'chatwoot', 'message.note',
          jsonb_build_object('command_id', p_command_id, 'conversa_id_local', p_conversa_id_local,
                             'conexao_id', v_conexao, 'payload_digest', v_digest),
          5) r
     where not r.is_duplicate;
    if v_evento is null then
        raise exception 'MSG-009: chave da nota ja usada.' using errcode = '23505';
    end if;

    insert into public.chatwoot_envios (organizacao_id, conexao_id, conversa_id_local, command_id, payload_digest,
                                        conteudo, ator_id, outbox_evento_id, controle_versao, privada)
    values (p_organizacao_id, v_conexao, p_conversa_id_local, p_command_id, v_digest,
            p_conteudo, p_ator_id, v_evento, p_controle_versao, true)
    returning id into v_envio;

    perform public.auditar_envio_chatwoot(p_organizacao_id, p_ator_id, 'chatwoot.send_requested', v_envio,
        jsonb_build_object('conexao_id', v_conexao, 'evento_id', v_evento, 'privada', true));
    return v_envio;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Assumir, devolver à automação, exigir humano.
--
-- Resultados: `aplicado`, `existente` (mesmo comando, mesmos parâmetros),
-- `conflito_comando` (mesmo comando, outros parâmetros), `conflito_versao`
-- (outra aba ou pessoa mudou antes), `transicao_invalida`, `sem_vinculo`,
-- `sem_capacidade`, `conversa_inexistente`. Só `aplicado` grava.
-- ---------------------------------------------------------------------------
create or replace function public.alterar_controle_atendimento_chatwoot(
    p_organizacao_id    uuid,
    p_ator_id           uuid,
    p_conversa_id_local uuid,
    p_command_id        uuid,
    p_acao              text,
    p_versao_esperada   bigint,
    p_nota              text default null
)
returns table (
    resultado       text,
    ownership_mode  text,
    responsavel_id  uuid,
    control_version bigint,
    invalidados     integer,
    em_voo          integer,
    nota_envio_id   uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_papel     text;
    v_digest    text;
    v_hist      record;
    v_controle  public.chatwoot_conversa_controle;
    v_novo_modo text;
    v_versao    bigint;
    v_invalid   integer;
    v_em_voo    integer;
    v_nota_id   uuid;
    v_texto     text;
begin
    if p_organizacao_id is null or p_ator_id is null or p_conversa_id_local is null or p_command_id is null
       or p_acao is null or p_acao not in ('assumir', 'devolver', 'exigir_humano')
       or p_versao_esperada is null or p_versao_esperada < 0
       or (p_nota is not null and (p_nota <> btrim(p_nota) or char_length(p_nota) not between 1 and 2000))
       or (p_acao = 'devolver' and p_nota is null) then
        raise exception 'MSG-009: comando de controle invalido.' using errcode = '22023';
    end if;

    select m.papel into v_papel
      from public.membros_organizacao m
     where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id;
    if not found then
        return query select 'sem_vinculo'::text, null::text, null::uuid, null::bigint, 0, 0, null::uuid;
        return;
    end if;
    -- Devolver liga a automação de novo: só quem gerencia a organização.
    if p_acao = 'devolver' and v_papel = 'member' then
        return query select 'sem_capacidade'::text, null::text, null::uuid, null::bigint, 0, 0, null::uuid;
        return;
    end if;

    if not exists (select 1 from public.chatwoot_conversations c
                    where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local) then
        return query select 'conversa_inexistente'::text, null::text, null::uuid, null::bigint, 0, 0, null::uuid;
        return;
    end if;

    v_digest := encode(pg_catalog.sha256(convert_to(
        p_conversa_id_local::text || chr(10) || p_acao || chr(10) || p_versao_esperada::text || chr(10) || coalesce(p_nota, ''),
        'UTF8')), 'hex');

    perform pg_advisory_xact_lock(hashtextextended('chatwoot_controle:' || p_organizacao_id::text || ':' || p_command_id::text, 0));

    select h.* into v_hist
      from public.chatwoot_controle_historico h
     where h.organizacao_id = p_organizacao_id and h.command_id = p_command_id;
    if found then
        if v_hist.comando_digest <> v_digest then
            return query select 'conflito_comando'::text, null::text, null::uuid, null::bigint, 0, 0, null::uuid;
            return;
        end if;
        select c.* into v_controle from public.chatwoot_conversa_controle c
         where c.organizacao_id = p_organizacao_id and c.conversa_id_local = p_conversa_id_local;
        return query select 'existente'::text, v_controle.ownership_mode, v_controle.responsavel_id, v_controle.control_version,
                            v_hist.invalidados, v_hist.em_voo, v_hist.nota_envio_id;
        return;
    end if;

    v_controle := public.travar_controle_chatwoot(p_organizacao_id, p_conversa_id_local, false);

    if v_controle.control_version <> p_versao_esperada then
        return query select 'conflito_versao'::text, v_controle.ownership_mode, v_controle.responsavel_id,
                            v_controle.control_version, 0, 0, null::uuid;
        return;
    end if;

    v_novo_modo := case p_acao when 'assumir' then 'HUMAN' when 'devolver' then 'AI' else 'HUMAN_REQUIRED' end;
    if (p_acao = 'assumir' and v_controle.ownership_mode = 'HUMAN' and v_controle.responsavel_id = p_ator_id)
       or (p_acao = 'devolver' and (v_controle.ownership_mode <> 'HUMAN' or v_controle.responsavel_id is distinct from p_ator_id))
       or (p_acao = 'exigir_humano' and v_controle.ownership_mode <> 'AI') then
        return query select 'transicao_invalida'::text, v_controle.ownership_mode, v_controle.responsavel_id,
                            v_controle.control_version, 0, 0, null::uuid;
        return;
    end if;

    v_versao := v_controle.control_version + 1;
    update public.chatwoot_conversa_controle c
       set ownership_mode = v_novo_modo,
           responsavel_id = case when v_novo_modo = 'HUMAN' then p_ator_id end,
           control_version = v_versao,
           updated_at = now()
     where c.organizacao_id = p_organizacao_id and c.conversa_id_local = p_conversa_id_local;

    v_invalid := public.invalidar_envios_na_fila_chatwoot(p_organizacao_id, p_conversa_id_local, v_versao);
    v_em_voo := public.contar_envios_em_voo_chatwoot(p_organizacao_id, p_conversa_id_local);

    v_texto := case p_acao
        when 'assumir' then 'ORBITA: atendimento assumido por um atendente.'
        when 'devolver' then 'ORBITA: atendimento devolvido à automação.'
        else 'ORBITA: conversa aguardando um atendente.' end
        || case when p_nota is null then '' when p_acao = 'devolver' then chr(10) || 'Resumo: ' || p_nota
                else chr(10) || 'Nota: ' || p_nota end;
    v_nota_id := public.registrar_nota_privada_chatwoot(p_organizacao_id, p_ator_id, p_conversa_id_local,
                                                         p_command_id, v_texto, v_versao);

    insert into public.chatwoot_controle_historico
        (organizacao_id, conversa_id_local, command_id, acao, comando_digest, modo_anterior, modo_novo,
         versao_resultante, ator_id, responsavel_anterior, nota, nota_envio_id, invalidados, em_voo)
    values (p_organizacao_id, p_conversa_id_local, p_command_id, p_acao, v_digest, v_controle.ownership_mode, v_novo_modo,
            v_versao, p_ator_id, v_controle.responsavel_id, p_nota, v_nota_id, v_invalid, v_em_voo);

    -- Sem o texto da nota: a trilha diz o que mudou, não o que foi escrito.
    -- `transferencia`: a conversa estava com outra pessoa.
    perform public.auditar_controle_chatwoot(p_organizacao_id, p_ator_id, p_conversa_id_local,
        jsonb_build_object('acao', p_acao, 'de', v_controle.ownership_mode, 'para', v_novo_modo, 'versao', v_versao,
                           'invalidados', v_invalid, 'em_voo', v_em_voo, 'nota_projetada', v_nota_id is not null,
                           'transferencia', v_controle.responsavel_id is not null and v_controle.responsavel_id <> p_ator_id));

    return query select 'aplicado'::text, v_novo_modo, case when v_novo_modo = 'HUMAN' then p_ator_id end, v_versao,
                        v_invalid, v_em_voo, v_nota_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Registro do envio (MSG-008) com o controle.
--
-- Novo resultado: `outro_responsavel` (a conversa está com outra pessoa).
-- Responder conversa sem dono (AI, HUMAN_REQUIRED ou dono removido) é
-- assumi-la, na mesma transação; dono que saiu da organização também não
-- segura a conversa. A repetição do mesmo comando continua
-- devolvendo `existente` antes de qualquer conferência de controle.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_envio_chatwoot(
    p_organizacao_id    uuid,
    p_ator_id           uuid,
    p_conversa_id_local uuid,
    p_command_id        uuid,
    p_conteudo          text
)
returns table (resultado text, envio_id uuid, evento_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_conversa  record;
    v_conexao   record;
    v_digest    text;
    v_existente record;
    v_evento    uuid;
    v_envio     uuid;
    v_controle  public.chatwoot_conversa_controle;
    v_versao    bigint;
    v_invalid   integer;
    v_em_voo    integer;
    v_dono_ativo boolean;
begin
    if p_organizacao_id is null or p_ator_id is null or p_conversa_id_local is null or p_command_id is null
       or p_conteudo is null or p_conteudo <> btrim(p_conteudo) or char_length(p_conteudo) not between 1 and 4096 then
        raise exception 'MSG-008: comando de envio invalido.' using errcode = '22023';
    end if;

    if not exists (select 1 from public.membros_organizacao m
                    where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id) then
        return query select 'sem_vinculo'::text, null::uuid, null::uuid, null::text;
        return;
    end if;

    select c.id_local, c.conexao_id into v_conversa
      from public.chatwoot_conversations c
     where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local;
    if not found then
        return query select 'conversa_inexistente'::text, null::uuid, null::uuid, null::text;
        return;
    end if;

    v_digest := encode(pg_catalog.sha256(convert_to(p_conversa_id_local::text || chr(10) || p_conteudo, 'UTF8')), 'hex');

    perform pg_advisory_xact_lock(hashtextextended('chatwoot_envio:' || p_organizacao_id::text || ':' || p_command_id::text, 0));

    select e.id, e.payload_digest, e.outbox_evento_id, o.status as status_evento into v_existente
      from public.chatwoot_envios e
      join public.outbox_eventos o on o.organizacao_id = e.organizacao_id and o.id = e.outbox_evento_id
     where e.organizacao_id = p_organizacao_id and e.command_id = p_command_id;
    if found then
        return query select (case when v_existente.payload_digest = v_digest then 'existente' else 'conflito' end)::text,
                            v_existente.id, v_existente.outbox_evento_id, v_existente.status_evento::text;
        return;
    end if;

    select i.id, i.status into v_conexao
      from public.conexoes_integracao i
     where i.id = v_conversa.conexao_id and i.organizacao_id = p_organizacao_id and i.provedor = 'chatwoot';
    if not found or v_conexao.status = 'desconectado' then
        return query select 'conexao_indisponivel'::text, null::uuid, null::uuid, null::text;
        return;
    end if;

    v_controle := public.travar_controle_chatwoot(p_organizacao_id, p_conversa_id_local, false);
    -- Quem saiu da organização não segura a conversa (como quem foi apagado).
    v_dono_ativo := v_controle.ownership_mode = 'HUMAN' and v_controle.responsavel_id is not null
        and exists (select 1 from public.membros_organizacao m
                     where m.organizacao_id = p_organizacao_id and m.user_id = v_controle.responsavel_id);
    if v_dono_ativo and v_controle.responsavel_id <> p_ator_id then
        return query select 'outro_responsavel'::text, null::uuid, null::uuid, null::text;
        return;
    end if;

    v_versao := v_controle.control_version;
    if not v_dono_ativo then
        -- Responder é assumir: a automação para e a fila antiga perde a vez.
        v_versao := v_versao + 1;
        update public.chatwoot_conversa_controle c
           set ownership_mode = 'HUMAN', responsavel_id = p_ator_id, control_version = v_versao, updated_at = now()
         where c.organizacao_id = p_organizacao_id and c.conversa_id_local = p_conversa_id_local;
        v_invalid := public.invalidar_envios_na_fila_chatwoot(p_organizacao_id, p_conversa_id_local, v_versao);
        v_em_voo := public.contar_envios_em_voo_chatwoot(p_organizacao_id, p_conversa_id_local);
        insert into public.chatwoot_controle_historico
            (organizacao_id, conversa_id_local, command_id, acao, comando_digest, modo_anterior, modo_novo,
             versao_resultante, ator_id, responsavel_anterior, invalidados, em_voo)
        values (p_organizacao_id, p_conversa_id_local, p_command_id, 'assumir_por_envio', v_digest,
                v_controle.ownership_mode, 'HUMAN', v_versao, p_ator_id, v_controle.responsavel_id, v_invalid, v_em_voo);
        perform public.auditar_controle_chatwoot(p_organizacao_id, p_ator_id, p_conversa_id_local,
            jsonb_build_object('acao', 'assumir_por_envio', 'de', v_controle.ownership_mode, 'para', 'HUMAN',
                               'versao', v_versao, 'invalidados', v_invalid, 'em_voo', v_em_voo, 'nota_projetada', false,
                               'transferencia', v_controle.responsavel_id is not null));
    end if;

    select r.evento_id into v_evento
      from public.registrar_evento_outbox(
          p_organizacao_id, v_conversa.conexao_id, p_ator_id,
          'chatwoot.message.send:' || p_command_id::text, 'chatwoot', 'message.send',
          jsonb_build_object('command_id', p_command_id, 'conversa_id_local', p_conversa_id_local,
                             'conexao_id', v_conversa.conexao_id, 'payload_digest', v_digest),
          5) r
     where not r.is_duplicate;
    if v_evento is null then
        raise exception 'MSG-008: chave da outbox ja usada fora de um envio registrado.' using errcode = '23505';
    end if;

    insert into public.chatwoot_envios (organizacao_id, conexao_id, conversa_id_local, command_id, payload_digest,
                                        conteudo, ator_id, outbox_evento_id, controle_versao)
    values (p_organizacao_id, v_conversa.conexao_id, p_conversa_id_local, p_command_id, v_digest,
            p_conteudo, p_ator_id, v_evento, v_versao)
    returning id into v_envio;

    perform public.auditar_envio_chatwoot(p_organizacao_id, p_ator_id, 'chatwoot.send_requested', v_envio,
        jsonb_build_object('conexao_id', v_conversa.conexao_id, 'evento_id', v_evento));

    return query select 'registrado'::text, v_envio, v_evento, 'pending'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Claim do worker, protocolo 2: devolve `privada`. A assinatura antiga sai,
-- para que um worker anterior a esta migration falhe ao reivindicar.
-- ---------------------------------------------------------------------------
drop function if exists public.reivindicar_envios_chatwoot(text, integer, integer, timestamptz);

create or replace function public.reivindicar_envios_chatwoot(
    p_worker_id      text,
    p_limit          integer,
    p_lease_ttl_sec  integer,
    p_criados_desde  timestamptz,
    p_protocolo      integer
)
returns table (
    evento_id          uuid,
    organizacao_id     uuid,
    conexao_id         uuid,
    envio_id           uuid,
    ator_id            uuid,
    conversa_id_local  uuid,
    conversa_id_externo text,
    conteudo           text,
    privada            boolean,
    correlation_id     text,
    fencing_token      bigint,
    lease_expires_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_protocolo is distinct from 2 then
        raise exception 'MSG-009: protocolo do worker de envio incompativel.' using errcode = '22023';
    end if;
    if p_worker_id is null or char_length(btrim(p_worker_id)) = 0 or char_length(p_worker_id) > 200 then
        raise exception 'p_worker_id invalido.' using errcode = '22023';
    end if;
    if p_limit is null or p_limit < 1 or p_limit > 50 then
        raise exception 'p_limit fora de 1..50.' using errcode = '22023';
    end if;
    if p_lease_ttl_sec is null or p_lease_ttl_sec < 5 or p_lease_ttl_sec > 300 then
        raise exception 'p_lease_ttl_sec fora de 5..300.' using errcode = '22023';
    end if;
    if p_criados_desde is null then
        raise exception 'MSG-008: o claim exige o corte do backlog.' using errcode = '22023';
    end if;

    return query
    with lote as (
        select o.id
          from public.outbox_eventos o
          join public.chatwoot_envios e on e.organizacao_id = o.organizacao_id and e.outbox_evento_id = o.id
         where o.destination = 'chatwoot'
           and o.event_type in ('message.send', 'message.note')
           and o.status in ('pending', 'failed_transient')
           and o.next_retry_at <= now()
           and e.created_at >= p_criados_desde
         order by o.next_retry_at asc, o.created_at asc
         limit p_limit
         for update of o skip locked
    ), reivindicados as (
        update public.outbox_eventos o
           set status = 'processing',
               lease_owner = p_worker_id,
               lease_expires_at = now() + make_interval(secs => p_lease_ttl_sec),
               updated_at = now()
          from lote
         where o.id = lote.id
        returning o.id, o.organizacao_id, o.correlation_id, o.fencing_token, o.lease_expires_at
    )
    select r.id, r.organizacao_id, e.conexao_id, e.id, e.ator_id, e.conversa_id_local, c.id_externo,
           e.conteudo, e.privada, r.correlation_id, r.fencing_token, r.lease_expires_at
      from reivindicados r
      join public.chatwoot_envios e on e.organizacao_id = r.organizacao_id and e.outbox_evento_id = r.id
      join public.chatwoot_conversations c on c.organizacao_id = e.organizacao_id and c.id_local = e.conversa_id_local;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Início do despacho com o controle conferido.
--
-- Resultados: `iniciado` (agora `in_flight`), `invalidado` (versão vencida:
-- `dead_letter` sem chamar o Chatwoot), `posse_perdida`. A trava
-- compartilhada no controle faz uma mudança concorrente esperar este início, e
-- este início esperar uma mudança em andamento: depois de `iniciado`, a
-- mudança vê o envio como em voo.
--
-- É o único caminho para `in_flight` de uma resposta ou nota do Chatwoot:
-- `iniciar_despacho_outbox` (genérico, MSG-007) passa a recusar evento com
-- intenção em `chatwoot_envios`, para que
-- um claim pelo caminho genérico não despache sem conferir a versão.
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
    if found and exists (select 1 from public.chatwoot_envios e
                          where e.organizacao_id = v_evt.organizacao_id and e.outbox_evento_id = v_evt.id) then
        raise exception 'MSG-009: resposta do Chatwoot so inicia por iniciar_envio_chatwoot.' using errcode = '55000';
    end if;
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

create or replace function public.iniciar_envio_chatwoot(
    p_evento_id     uuid,
    p_worker_id     text,
    p_fencing_token bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_envio    record;
    v_controle public.chatwoot_conversa_controle;
    v_evento   record;
begin
    select e.id, e.organizacao_id, e.conexao_id, e.conversa_id_local, e.controle_versao, e.privada into v_envio
      from public.chatwoot_envios e
     where e.outbox_evento_id = p_evento_id;
    if not found then
        raise exception 'MSG-009: evento sem envio registrado.' using errcode = '22023';
    end if;

    if not v_envio.privada then
        v_controle := public.travar_controle_chatwoot(v_envio.organizacao_id, v_envio.conversa_id_local, true);
    end if;

    select o.* into v_evento from public.outbox_eventos o where o.id = p_evento_id for update;
    if not found
       or v_evento.status <> 'processing'
       or v_evento.lease_owner is distinct from p_worker_id
       or v_evento.fencing_token is distinct from p_fencing_token
       or v_evento.lease_expires_at is null
       or v_evento.lease_expires_at < now() then
        return 'posse_perdida';
    end if;

    if not v_envio.privada then
        if v_controle.control_version <> v_envio.controle_versao then
            update public.outbox_eventos
               set status = 'dead_letter',
                   last_error = 'Envio invalidado: o controle do atendimento mudou antes do despacho.',
                   last_error_category = 'permanent',
                   attempts = v_evento.attempts + 1,
                   lease_owner = null, lease_expires_at = null, updated_at = now()
             where id = p_evento_id;
            update public.chatwoot_envios set invalidado_em = now() where id = v_envio.id and invalidado_em is null;
            perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'chatwoot.send_invalidated', v_envio.id,
                jsonb_build_object('conexao_id', v_envio.conexao_id, 'evento_id', p_evento_id,
                                   'versao_vigente', v_controle.control_version));
            return 'invalidado';
        end if;
    end if;

    update public.outbox_eventos
       set status = 'in_flight', despachado_em = now(), updated_at = now()
     where id = p_evento_id;
    insert into public.outbox_tentativas (organizacao_id, evento_id, fencing_token, worker_id)
    values (v_evento.organizacao_id, v_evento.id, v_evento.fencing_token, p_worker_id);
    return 'iniciado';
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Conclusão: nota privada não vira mensagem espelhada (o cockpit mostra
-- mensagens da conversa com a cliente). O resto é o MSG-008.
-- ---------------------------------------------------------------------------
create or replace function public.concluir_envio_chatwoot(
    p_evento_id        uuid,
    p_worker_id        text,
    p_fencing_token    bigint,
    p_desfecho         text,
    p_recibo_ref       text default null,
    p_motivo           text default null,
    p_erro             text default null,
    p_categoria        text default null,
    p_retry_delay_sec  integer default 10,
    p_mensagem         jsonb default null
)
returns table (status text, mensagem_id_local uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_envio     record;
    v_status    text;
    v_mensagem  uuid;
    v_criada_em timestamptz;
begin
    if p_desfecho = 'confirmado' and (p_recibo_ref is null or p_recibo_ref !~ '^[1-9][0-9]{0,9}$'
                                      or p_recibo_ref::bigint > 2147483647) then
        raise exception 'MSG-008: recibo do Chatwoot invalido.' using errcode = '22023';
    end if;

    select e.*, c.id_externo as conversa_id_externo into v_envio
      from public.chatwoot_envios e
      join public.chatwoot_conversations c on c.organizacao_id = e.organizacao_id and c.id_local = e.conversa_id_local
     where e.outbox_evento_id = p_evento_id
       for update of e;
    if not found then
        raise exception 'MSG-008: evento sem envio registrado.' using errcode = '22023';
    end if;

    v_status := public.concluir_tentativa_outbox(
        p_evento_id, p_worker_id, p_fencing_token, p_desfecho, p_recibo_ref,
        case when p_desfecho = 'confirmado' then jsonb_build_object('id', p_recibo_ref::bigint) end,
        p_motivo, p_erro, p_categoria, p_retry_delay_sec);

    if v_status is null then
        return query select null::text, null::uuid;
        return;
    end if;

    if v_status = 'sent' then
        if not v_envio.privada then
            v_criada_em := coalesce((p_mensagem ->> 'criada_em')::timestamptz, now());
            insert into public.chatwoot_messages as m
                (id, id_externo, organizacao_id, conexao_id, user_id, conversa_id_local, conversation_id, content,
                 message_type, sender_name, sender_id, sender_type, created_at, envio_id)
            values (p_recibo_ref::integer, p_recibo_ref, v_envio.organizacao_id, v_envio.conexao_id, v_envio.ator_id,
                    v_envio.conversa_id_local, v_envio.conversa_id_externo::integer, v_envio.conteudo, 'outgoing',
                    left(coalesce(p_mensagem ->> 'remetente_nome', 'Atendente Orbita'), 200),
                    nullif(p_mensagem ->> 'remetente_id', '')::integer,
                    coalesce(nullif(p_mensagem ->> 'remetente_tipo', ''), 'user'),
                    v_criada_em, v_envio.id)
            on conflict (organizacao_id, conexao_id, id_externo)
                do update set envio_id = coalesce(m.envio_id, excluded.envio_id)
            returning m.id_local into v_mensagem;

            update public.chatwoot_envios set mensagem_id_local = v_mensagem
             where id = v_envio.id and mensagem_id_local is null;
        end if;

        perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'chatwoot.send_confirmed', v_envio.id,
            jsonb_build_object('conexao_id', v_envio.conexao_id, 'evento_id', p_evento_id));
    elsif v_status = 'dead_letter' then
        perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'chatwoot.send_rejected', v_envio.id,
            jsonb_build_object('conexao_id', v_envio.conexao_id, 'evento_id', p_evento_id, 'motivo', p_motivo));
    elsif v_status = 'unknown' then
        perform public.auditar_envio_chatwoot(v_envio.organizacao_id, null, 'outbox.effect_unknown', v_envio.id,
            jsonb_build_object('destino', 'chatwoot', 'tipo', 'message.send', 'evento_id', p_evento_id, 'motivo', p_motivo));
    end if;

    return query select v_status, v_mensagem;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Leitura do controle para a tela, com a mesma regra das escritas:
-- conversa de outra organização (ou inexistente) é `conversa_inexistente`,
-- nunca um estado padrão; sem linha, HUMAN_REQUIRED versão 0; responsável que
-- saiu da organização não aparece como dono.
-- ---------------------------------------------------------------------------
create or replace function public.ler_controle_atendimento_chatwoot(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid
)
returns table (resultado text, ownership_mode text, responsavel_id uuid, control_version bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
    if p_organizacao_id is null or p_conversa_id_local is null then
        raise exception 'MSG-009: leitura de controle invalida.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.chatwoot_conversations c
                    where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local) then
        return query select 'conversa_inexistente'::text, null::text, null::uuid, null::bigint;
        return;
    end if;
    return query
    select 'encontrada'::text,
           coalesce(k.ownership_mode, 'HUMAN_REQUIRED'),
           case when exists (select 1 from public.membros_organizacao m
                              where m.organizacao_id = p_organizacao_id and m.user_id = k.responsavel_id)
                then k.responsavel_id end,
           coalesce(k.control_version, 0)
      from (select 1) as uma
      left join public.chatwoot_conversa_controle k
        on k.organizacao_id = p_organizacao_id and k.conversa_id_local = p_conversa_id_local;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Superfície: só o servidor. Os auxiliares nem pelo servidor.
-- ---------------------------------------------------------------------------
revoke all on function public.auditar_controle_chatwoot(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.travar_controle_chatwoot(uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.invalidar_envios_na_fila_chatwoot(uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.contar_envios_em_voo_chatwoot(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.registrar_nota_privada_chatwoot(uuid, uuid, uuid, uuid, text, bigint)
    from public, anon, authenticated, service_role;
revoke all on function public.alterar_controle_atendimento_chatwoot(uuid, uuid, uuid, uuid, text, bigint, text)
    from public, anon, authenticated;
revoke all on function public.registrar_envio_chatwoot(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.reivindicar_envios_chatwoot(text, integer, integer, timestamptz, integer)
    from public, anon, authenticated;
revoke all on function public.iniciar_envio_chatwoot(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.concluir_envio_chatwoot(uuid, text, bigint, text, text, text, text, text, integer, jsonb)
    from public, anon, authenticated;
grant execute on function public.alterar_controle_atendimento_chatwoot(uuid, uuid, uuid, uuid, text, bigint, text)
    to service_role;
grant execute on function public.registrar_envio_chatwoot(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.reivindicar_envios_chatwoot(text, integer, integer, timestamptz, integer) to service_role;
grant execute on function public.iniciar_envio_chatwoot(uuid, text, bigint) to service_role;
grant execute on function public.concluir_envio_chatwoot(uuid, text, bigint, text, text, text, text, text, integer, jsonb)
    to service_role;
revoke all on function public.ler_controle_atendimento_chatwoot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ler_controle_atendimento_chatwoot(uuid, uuid) to service_role;

-- Autoverificação: nada desta migration fica acessível ao navegador, e o
-- servidor não escreve no controle sem passar pelas funções.
do $$
begin
    if has_table_privilege('authenticated', 'public.chatwoot_conversa_controle', 'select')
       or has_table_privilege('anon', 'public.chatwoot_conversa_controle', 'select')
       or has_table_privilege('service_role', 'public.chatwoot_conversa_controle', 'update')
       or has_table_privilege('authenticated', 'public.chatwoot_controle_historico', 'select')
       or has_table_privilege('service_role', 'public.chatwoot_controle_historico', 'insert')
       or has_function_privilege('authenticated',
              'public.alterar_controle_atendimento_chatwoot(uuid,uuid,uuid,uuid,text,bigint,text)', 'execute')
       or has_function_privilege('authenticated', 'public.iniciar_envio_chatwoot(uuid,text,bigint)', 'execute')
       or has_function_privilege('authenticated', 'public.ler_controle_atendimento_chatwoot(uuid,uuid)', 'execute')
       or has_function_privilege('service_role', 'public.travar_controle_chatwoot(uuid,uuid,boolean)', 'execute')
       or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'reivindicar_envios_chatwoot' and p.pronargs = 4) then
        raise exception 'MSG-009: superficie de controle exposta ou claim antigo presente.';
    end if;
end;
$$;
