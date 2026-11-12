-- 92_vinculo_cliente_conversa.sql
-- Forward-only. MSG-010: a conversa só revela pedidos depois que um atendente
-- confirma quem é a pessoa, e a consulta fica presa ao cliente confirmado.
--
-- ESTADO ANTERIOR (cadeia 01-91):
--   - Nada liga uma conversa a um cliente. O sync cria cliente local a partir
--     do contato pelo telefone (`registrar_cliente_do_sac`, migration 80), mas
--     isso é cadastro, não prova de quem está escrevendo.
--   - Não existe consulta de pedido a partir de uma conversa.
--
-- O QUE MUDA:
--   1. `sac_vinculos_cliente`: a prova. Uma por comando; no máximo uma não
--      revogada por conversa. Método `humano` (D2 pendente: o padrão seguro é
--      a verificação por atendente). Vale 24 horas, enquanto o caso em que
--      nasceu estiver aberto e o cliente não tiver sido anonimizado.
--   2. `sac_consultas_recusadas`: cada consulta por número que não achou
--      pedido do cliente confirmado. Sem o número tentado.
--   3. `ler_verificacao_cliente_sac` e `listar_candidatos_cliente_sac`: o
--      estado da conversa e os clientes com o mesmo telefone do contato.
--      Telefone igual é só candidato; nunca cria vínculo.
--   4. `confirmar_vinculo_cliente_sac` e `revogar_vinculo_cliente_sac`: o
--      atendente confirma (substituindo a prova anterior) ou desfaz.
--   5. `consultar_pedidos_do_cliente_verificado_sac`: lista os pedidos do
--      cliente confirmado, ou procura um número só entre eles. Não recebe
--      cliente: ele vem da prova. Pedido de outro cliente, de outra
--      organização ou inexistente dão a mesma resposta. Cinco números errados
--      em 15 minutos bloqueiam a consulta por número da conversa.
--
-- O QUE NÃO MUDA: clientes, pedidos, conversas, casos e o controle do
-- atendimento (MSG-009). Nenhuma linha existente é alterada.
--
-- RECUPERAÇÃO: forward-only. Ver docs/operations/msg-010-runbook.md.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. A prova do vínculo.
-- ---------------------------------------------------------------------------
create table if not exists public.sac_vinculos_cliente (
    id                 uuid primary key default gen_random_uuid(),
    organizacao_id     uuid not null references public.organizacoes(id) on delete cascade,
    conversa_id_local  uuid not null,
    -- O caso aberto quando a prova foi dada; fechado o caso, a prova deixa de valer.
    caso_id            uuid,
    cliente_id         uuid not null,
    metodo             text not null default 'humano',
    verificado_por     uuid references auth.users(id) on delete set null,
    command_id         uuid not null,
    created_at         timestamptz not null default now(),
    expira_em          timestamptz not null,
    revogado_em        timestamptz,
    revogado_por       uuid references auth.users(id) on delete set null,
    revogacao_motivo   text,
    constraint ck_sac_vinculos_cliente_metodo check (metodo in ('humano')),
    constraint ck_sac_vinculos_cliente_validade check (expira_em > created_at),
    constraint ck_sac_vinculos_cliente_revogacao
        check ((revogado_em is null) = (revogacao_motivo is null)
               and (revogacao_motivo is null or revogacao_motivo in ('substituido', 'revogado'))),
    constraint uq_sac_vinculos_cliente_comando unique (organizacao_id, command_id),
    constraint fk_sac_vinculos_cliente_conversa foreign key (organizacao_id, conversa_id_local)
        references public.chatwoot_conversations(organizacao_id, id_local) on delete cascade,
    constraint fk_sac_vinculos_cliente_caso foreign key (organizacao_id, caso_id)
        references public.sac_cases(organizacao_id, id) on delete set null (caso_id),
    -- Cliente da mesma organização, pela chave composta da migration 40.
    constraint fk_sac_vinculos_cliente_cliente foreign key (cliente_id, organizacao_id)
        references public.clientes(id, organizacao_id) on delete cascade
);

create unique index if not exists uq_sac_vinculos_cliente_conversa_vigente
    on public.sac_vinculos_cliente (organizacao_id, conversa_id_local)
    where revogado_em is null;
create index if not exists idx_sac_vinculos_cliente_cliente
    on public.sac_vinculos_cliente (cliente_id, organizacao_id);
create index if not exists idx_sac_vinculos_cliente_caso
    on public.sac_vinculos_cliente (organizacao_id, caso_id)
    where caso_id is not null;
create index if not exists idx_sac_vinculos_cliente_verificado_por
    on public.sac_vinculos_cliente (verificado_por)
    where verificado_por is not null;
create index if not exists idx_sac_vinculos_cliente_revogado_por
    on public.sac_vinculos_cliente (revogado_por)
    where revogado_por is not null;

alter table public.sac_vinculos_cliente enable row level security;
revoke all on public.sac_vinculos_cliente from public, anon, authenticated, service_role;

-- A prova não muda: só pode ser revogada, uma vez. As FKs ainda podem
-- esvaziar o caso e as pessoas removidas.
create or replace function public.fn_sac_vinculo_cliente_imutavel()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if new.id is distinct from old.id
       or new.organizacao_id is distinct from old.organizacao_id
       or new.conversa_id_local is distinct from old.conversa_id_local
       or new.cliente_id is distinct from old.cliente_id
       or new.metodo is distinct from old.metodo
       or new.command_id is distinct from old.command_id
       or new.created_at is distinct from old.created_at
       or new.expira_em is distinct from old.expira_em
       or (new.caso_id is distinct from old.caso_id and new.caso_id is not null)
       or (new.verificado_por is distinct from old.verificado_por and new.verificado_por is not null)
       or (old.revogado_em is not null
           and (new.revogado_em is distinct from old.revogado_em
                or new.revogacao_motivo is distinct from old.revogacao_motivo
                or (new.revogado_por is distinct from old.revogado_por and new.revogado_por is not null))) then
        raise exception 'MSG-010: a prova do vinculo e imutavel.' using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_sac_vinculo_cliente_imutavel() from public, anon, authenticated, service_role;

drop trigger if exists tg_sac_vinculo_cliente_imutavel on public.sac_vinculos_cliente;
create trigger tg_sac_vinculo_cliente_imutavel
    before update on public.sac_vinculos_cliente
    for each row execute function public.fn_sac_vinculo_cliente_imutavel();

-- ---------------------------------------------------------------------------
-- 2. Consultas por número que não acharam pedido do cliente confirmado.
-- ---------------------------------------------------------------------------
create table if not exists public.sac_consultas_recusadas (
    id                 bigint generated always as identity primary key,
    organizacao_id     uuid not null references public.organizacoes(id) on delete cascade,
    conversa_id_local  uuid not null,
    created_at         timestamptz not null default now(),
    constraint fk_sac_consultas_recusadas_conversa foreign key (organizacao_id, conversa_id_local)
        references public.chatwoot_conversations(organizacao_id, id_local) on delete cascade
);

create index if not exists idx_sac_consultas_recusadas_conversa
    on public.sac_consultas_recusadas (organizacao_id, conversa_id_local, created_at desc);

alter table public.sac_consultas_recusadas enable row level security;
revoke all on public.sac_consultas_recusadas from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Trilha: o que mudou e por quem, sem documento, telefone ou número tentado.
-- ---------------------------------------------------------------------------
insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('sac.customer_verified', 1, 'sac', 'info', 'user', 1825, null,
     'Atendente confirmou o cliente da conversa; a consulta de pedidos fica liberada para esse cliente.'),
    ('sac.customer_verification_revoked', 1, 'sac', 'info', 'user', 1825, null,
     'Atendente desfez a confirmação do cliente da conversa.'),
    ('sac.order_lookup_blocked', 1, 'sac', 'warning', 'system', 1825, null,
     'Consulta de pedido por número bloqueada na conversa depois de tentativas seguidas sem resultado.')
on conflict (nome) do nothing;

create or replace function public.auditar_vinculo_cliente_sac(
    p_organizacao_id uuid,
    p_ator_id        uuid,
    p_acao           text,
    p_recurso_id     uuid,
    p_metadata       jsonb
)
returns void
language sql
security invoker
set search_path = ''
as $$
    insert into public.eventos_auditoria_sistema (organizacao_id, actor_id, acao, recurso, recurso_id, correlation_id, metadata)
    values (p_organizacao_id, p_ator_id, p_acao, 'sac_vinculo_cliente', p_recurso_id::text, null,
            case when p_ator_id is null then p_metadata || '{"_source": "system"}'::jsonb else p_metadata end);
$$;

-- ---------------------------------------------------------------------------
-- 4. Regras compartilhadas.
-- ---------------------------------------------------------------------------
-- A prova que vale agora: não revogada, dentro do prazo, com o caso de origem
-- ainda aberto e o cliente não anonimizado.
create or replace function public.sac_vinculo_vigente(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid
)
returns public.sac_vinculos_cliente
language sql
stable
security invoker
set search_path = ''
as $$
    select v.*
      from public.sac_vinculos_cliente v
      join public.clientes c on c.id = v.cliente_id and c.organizacao_id = v.organizacao_id
     where v.organizacao_id = p_organizacao_id
       and v.conversa_id_local = p_conversa_id_local
       and v.revogado_em is null
       and v.expira_em > now()
       and c.anonimizado_em is null
       and (v.caso_id is null
            or exists (select 1 from public.sac_cases s
                        where s.organizacao_id = v.organizacao_id and s.id = v.caso_id
                          and s.phase not in ('RESOLVED', 'CLOSED', 'CANCELLED')));
$$;

-- Consultas sem resultado na janela que conta para o bloqueio.
create or replace function public.sac_consultas_recusadas_recentes(
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
      from public.sac_consultas_recusadas r
     where r.organizacao_id = p_organizacao_id
       and r.conversa_id_local = p_conversa_id_local
       and r.created_at > now() - interval '15 minutes';
$$;

-- ---------------------------------------------------------------------------
-- 5. Leitura do estado da conversa.
--
-- `estado`: `verificado`, `expirada` (existe prova não revogada que deixou de
-- valer) ou `sem_prova`. `candidatos` conta os clientes da organização com o
-- telefone do contato: 0, 1 ou vários. Nenhum deles é vínculo.
-- ---------------------------------------------------------------------------
create or replace function public.ler_verificacao_cliente_sac(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid
)
returns table (
    resultado          text,
    estado             text,
    cliente_id         uuid,
    cliente_nome       text,
    verificado_em      timestamptz,
    expira_em          timestamptz,
    candidatos         integer,
    consulta_bloqueada boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_vigente    public.sac_vinculos_cliente;
    v_telefone   text;
    v_candidatos integer;
    v_bloqueada  boolean;
begin
    if p_organizacao_id is null or p_conversa_id_local is null then
        raise exception 'MSG-010: leitura de verificacao invalida.' using errcode = '22023';
    end if;

    select k.phone_normalizado into v_telefone
      from public.chatwoot_conversations c
      left join public.chatwoot_contacts k on k.organizacao_id = c.organizacao_id and k.id_local = c.contato_id_local
     where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local;
    if not found then
        return query select 'conversa_inexistente'::text, null::text, null::uuid, null::text,
                            null::timestamptz, null::timestamptz, null::integer, null::boolean;
        return;
    end if;

    select count(*)::integer into v_candidatos
      from public.clientes c
     where c.organizacao_id = p_organizacao_id
       and v_telefone is not null
       and c.telefone_normalizado = v_telefone
       and c.anonimizado_em is null;
    v_bloqueada := public.sac_consultas_recusadas_recentes(p_organizacao_id, p_conversa_id_local) >= 5;

    v_vigente := public.sac_vinculo_vigente(p_organizacao_id, p_conversa_id_local);
    if v_vigente.id is not null then
        return query
        select 'encontrada'::text, 'verificado'::text, v_vigente.cliente_id, c.nome, v_vigente.created_at,
               v_vigente.expira_em, v_candidatos, v_bloqueada
          from public.clientes c
         where c.id = v_vigente.cliente_id and c.organizacao_id = p_organizacao_id;
        return;
    end if;

    return query
    select 'encontrada'::text,
           case when exists (select 1 from public.sac_vinculos_cliente v
                              where v.organizacao_id = p_organizacao_id
                                and v.conversa_id_local = p_conversa_id_local
                                and v.revogado_em is null)
                then 'expirada' else 'sem_prova' end,
           null::uuid, null::text, null::timestamptz, null::timestamptz, v_candidatos, v_bloqueada;
end;
$$;

-- Os clientes com o telefone do contato, para o atendente escolher. Nome e os
-- dois últimos dígitos do documento; nunca o documento inteiro. Conversa de
-- outra organização não devolve linha.
create or replace function public.listar_candidatos_cliente_sac(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid
)
returns table (cliente_id uuid, nome text, documento_final text)
language sql
stable
security definer
set search_path = ''
as $$
    select c.id, c.nome, nullif(right(regexp_replace(coalesce(c.cpf_cnpj, ''), '\D', '', 'g'), 2), '')
      from public.chatwoot_conversations v
      join public.chatwoot_contacts k on k.organizacao_id = v.organizacao_id and k.id_local = v.contato_id_local
      join public.clientes c on c.organizacao_id = v.organizacao_id and c.telefone_normalizado = k.phone_normalizado
     where v.organizacao_id = p_organizacao_id
       and v.id_local = p_conversa_id_local
       and c.anonimizado_em is null
     order by c.nome, c.id
     limit 5;
$$;

-- ---------------------------------------------------------------------------
-- 6. Confirmar e revogar.
--
-- Confirmar: `aplicado`, `existente` (mesmo comando, mesmos dados),
-- `conflito_comando`, `sem_vinculo` (ator fora da organização),
-- `conversa_inexistente`, `cliente_inexistente` (inexistente, de outra
-- organização ou anonimizado: a mesma resposta). Só `aplicado` grava.
-- ---------------------------------------------------------------------------
create or replace function public.confirmar_vinculo_cliente_sac(
    p_organizacao_id    uuid,
    p_ator_id           uuid,
    p_conversa_id_local uuid,
    p_command_id        uuid,
    p_cliente_id        uuid
)
returns table (resultado text, vinculo_id uuid, cliente_id uuid, expira_em timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_existente   public.sac_vinculos_cliente;
    v_telefone    text;
    v_caso        uuid;
    v_vinculo     uuid;
    v_expira      timestamptz;
    v_substituiu  boolean;
    v_candidato   boolean;
begin
    if p_organizacao_id is null or p_ator_id is null or p_conversa_id_local is null or p_command_id is null
       or p_cliente_id is null then
        raise exception 'MSG-010: comando de verificacao invalido.' using errcode = '22023';
    end if;

    if not exists (select 1 from public.membros_organizacao m
                    where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id) then
        return query select 'sem_vinculo'::text, null::uuid, null::uuid, null::timestamptz;
        return;
    end if;

    select k.phone_normalizado into v_telefone
      from public.chatwoot_conversations c
      left join public.chatwoot_contacts k on k.organizacao_id = c.organizacao_id and k.id_local = c.contato_id_local
     where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local;
    if not found then
        return query select 'conversa_inexistente'::text, null::uuid, null::uuid, null::timestamptz;
        return;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('sac_vinculo_comando:' || p_organizacao_id::text || ':' || p_command_id::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('sac_vinculo:' || p_organizacao_id::text || ':' || p_conversa_id_local::text, 0));

    select v.* into v_existente
      from public.sac_vinculos_cliente v
     where v.organizacao_id = p_organizacao_id and v.command_id = p_command_id;
    if found then
        if v_existente.conversa_id_local = p_conversa_id_local and v_existente.cliente_id = p_cliente_id then
            return query select 'existente'::text, v_existente.id, v_existente.cliente_id, v_existente.expira_em;
        else
            return query select 'conflito_comando'::text, null::uuid, null::uuid, null::timestamptz;
        end if;
        return;
    end if;

    if not exists (select 1 from public.clientes c
                    where c.id = p_cliente_id and c.organizacao_id = p_organizacao_id and c.anonimizado_em is null) then
        return query select 'cliente_inexistente'::text, null::uuid, null::uuid, null::timestamptz;
        return;
    end if;

    update public.sac_vinculos_cliente v
       set revogado_em = now(), revogado_por = p_ator_id, revogacao_motivo = 'substituido'
     where v.organizacao_id = p_organizacao_id and v.conversa_id_local = p_conversa_id_local and v.revogado_em is null;
    v_substituiu := found;

    select s.id into v_caso
      from public.sac_cases s
     where s.organizacao_id = p_organizacao_id and s.conversa_id_local = p_conversa_id_local
       and s.phase not in ('RESOLVED', 'CLOSED', 'CANCELLED');

    insert into public.sac_vinculos_cliente as v
        (organizacao_id, conversa_id_local, caso_id, cliente_id, verificado_por, command_id, expira_em)
    values (p_organizacao_id, p_conversa_id_local, v_caso, p_cliente_id, p_ator_id, p_command_id, now() + interval '24 hours')
    returning v.id, v.expira_em into v_vinculo, v_expira;

    v_candidato := v_telefone is not null
        and exists (select 1 from public.clientes c
                     where c.id = p_cliente_id and c.organizacao_id = p_organizacao_id
                       and c.telefone_normalizado = v_telefone);
    perform public.auditar_vinculo_cliente_sac(p_organizacao_id, p_ator_id, 'sac.customer_verified', v_vinculo,
        jsonb_build_object('conversa_id_local', p_conversa_id_local, 'caso_id', v_caso, 'cliente_id', p_cliente_id,
                           'metodo', 'humano', 'telefone_confere', v_candidato, 'substituiu', v_substituiu,
                           'expira_em', v_expira));

    return query select 'aplicado'::text, v_vinculo, p_cliente_id, v_expira;
end;
$$;

-- Revogar: `aplicado`, `sem_prova` (nada a desfazer), `sem_vinculo`,
-- `conversa_inexistente`. Desfaz também a prova que já deixou de valer.
create or replace function public.revogar_vinculo_cliente_sac(
    p_organizacao_id    uuid,
    p_ator_id           uuid,
    p_conversa_id_local uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_vinculo uuid;
begin
    if p_organizacao_id is null or p_ator_id is null or p_conversa_id_local is null then
        raise exception 'MSG-010: comando de verificacao invalido.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.membros_organizacao m
                    where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id) then
        return 'sem_vinculo';
    end if;
    if not exists (select 1 from public.chatwoot_conversations c
                    where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local) then
        return 'conversa_inexistente';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('sac_vinculo:' || p_organizacao_id::text || ':' || p_conversa_id_local::text, 0));

    update public.sac_vinculos_cliente v
       set revogado_em = now(), revogado_por = p_ator_id, revogacao_motivo = 'revogado'
     where v.organizacao_id = p_organizacao_id and v.conversa_id_local = p_conversa_id_local and v.revogado_em is null
    returning v.id into v_vinculo;
    if v_vinculo is null then
        return 'sem_prova';
    end if;

    perform public.auditar_vinculo_cliente_sac(p_organizacao_id, p_ator_id, 'sac.customer_verification_revoked', v_vinculo,
        jsonb_build_object('conversa_id_local', p_conversa_id_local));
    return 'aplicado';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Consulta de pedidos, presa ao cliente confirmado.
--
-- Sempre devolve ao menos uma linha. `resultado`:
--   `pedido`               uma linha por pedido (no máximo 10, mais recentes primeiro);
--   `sem_pedidos`          prova válida, cliente sem pedido;
--   `nao_encontrado`       número informado não é de pedido deste cliente
--                          (inexistente, de outro cliente ou de outra organização);
--   `bloqueada`            cinco números sem resultado em 15 minutos; a consulta
--                          por número para sem avaliar o número informado;
--   `sem_prova`            sem prova válida: nada é consultado;
--   `conversa_inexistente` conversa de outra organização ou inexistente.
-- A função não recebe cliente nem pedido interno: o cliente vem da prova.
-- ---------------------------------------------------------------------------
create or replace function public.consultar_pedidos_do_cliente_verificado_sac(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid,
    p_numero            text default null
)
returns table (resultado text, pedido_id uuid, numero text, data timestamptz, status text, total numeric)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_vigente  public.sac_vinculos_cliente;
    v_recusas  integer;
begin
    if p_organizacao_id is null or p_conversa_id_local is null
       or (p_numero is not null and (p_numero <> btrim(p_numero) or char_length(p_numero) not between 1 and 40)) then
        raise exception 'MSG-010: consulta de pedidos invalida.' using errcode = '22023';
    end if;

    if not exists (select 1 from public.chatwoot_conversations c
                    where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local) then
        return query select 'conversa_inexistente'::text, null::uuid, null::text, null::timestamptz, null::text, null::numeric;
        return;
    end if;

    v_vigente := public.sac_vinculo_vigente(p_organizacao_id, p_conversa_id_local);
    if v_vigente.id is null then
        return query select 'sem_prova'::text, null::uuid, null::text, null::timestamptz, null::text, null::numeric;
        return;
    end if;

    if p_numero is null then
        return query
        select 'pedido'::text, p.id, p.numero, p.data, p.status, p.total
          from public.pedidos p
         where p.organizacao_id = p_organizacao_id and p.cliente_id = v_vigente.cliente_id
         order by p.data desc, p.id
         limit 10;
        if not found then
            return query select 'sem_pedidos'::text, null::uuid, null::text, null::timestamptz, null::text, null::numeric;
        end if;
        return;
    end if;

    -- Uma tentativa por vez na conversa: a contagem e o registro não correm em paralelo.
    perform pg_advisory_xact_lock(hashtextextended('sac_consulta:' || p_organizacao_id::text || ':' || p_conversa_id_local::text, 0));
    v_recusas := public.sac_consultas_recusadas_recentes(p_organizacao_id, p_conversa_id_local);
    if v_recusas >= 5 then
        return query select 'bloqueada'::text, null::uuid, null::text, null::timestamptz, null::text, null::numeric;
        return;
    end if;

    return query
    select 'pedido'::text, p.id, p.numero, p.data, p.status, p.total
      from public.pedidos p
     where p.organizacao_id = p_organizacao_id and p.cliente_id = v_vigente.cliente_id and p.numero = p_numero
     order by p.data desc, p.id
     limit 10;
    if found then
        return;
    end if;

    delete from public.sac_consultas_recusadas r
     where r.organizacao_id = p_organizacao_id and r.conversa_id_local = p_conversa_id_local
       and r.created_at < now() - interval '1 day';
    insert into public.sac_consultas_recusadas (organizacao_id, conversa_id_local)
    values (p_organizacao_id, p_conversa_id_local);
    if v_recusas + 1 = 5 then
        perform public.auditar_vinculo_cliente_sac(p_organizacao_id, null, 'sac.order_lookup_blocked', v_vigente.id,
            jsonb_build_object('conversa_id_local', p_conversa_id_local, 'recusas', 5, 'janela_minutos', 15));
    end if;
    return query select 'nao_encontrado'::text, null::uuid, null::text, null::timestamptz, null::text, null::numeric;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Superfície: só o servidor, e só pelas funções.
-- ---------------------------------------------------------------------------
revoke all on function public.auditar_vinculo_cliente_sac(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.sac_vinculo_vigente(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.sac_consultas_recusadas_recentes(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.ler_verificacao_cliente_sac(uuid, uuid) from public, anon, authenticated;
revoke all on function public.listar_candidatos_cliente_sac(uuid, uuid) from public, anon, authenticated;
revoke all on function public.confirmar_vinculo_cliente_sac(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.revogar_vinculo_cliente_sac(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.consultar_pedidos_do_cliente_verificado_sac(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ler_verificacao_cliente_sac(uuid, uuid) to service_role;
grant execute on function public.listar_candidatos_cliente_sac(uuid, uuid) to service_role;
grant execute on function public.confirmar_vinculo_cliente_sac(uuid, uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.revogar_vinculo_cliente_sac(uuid, uuid, uuid) to service_role;
grant execute on function public.consultar_pedidos_do_cliente_verificado_sac(uuid, uuid, text) to service_role;

-- Autoverificação: nada desta migration fica acessível ao navegador, e o
-- servidor não lê nem escreve as tabelas sem passar pelas funções.
do $$
begin
    if has_table_privilege('authenticated', 'public.sac_vinculos_cliente', 'select')
       or has_table_privilege('anon', 'public.sac_vinculos_cliente', 'select')
       or has_table_privilege('service_role', 'public.sac_vinculos_cliente', 'select')
       or has_table_privilege('service_role', 'public.sac_vinculos_cliente', 'insert')
       or has_table_privilege('authenticated', 'public.sac_consultas_recusadas', 'select')
       or has_table_privilege('service_role', 'public.sac_consultas_recusadas', 'delete')
       or has_function_privilege('authenticated', 'public.confirmar_vinculo_cliente_sac(uuid,uuid,uuid,uuid,uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.consultar_pedidos_do_cliente_verificado_sac(uuid,uuid,text)', 'execute')
       or has_function_privilege('anon', 'public.listar_candidatos_cliente_sac(uuid,uuid)', 'execute')
       or has_function_privilege('service_role', 'public.sac_vinculo_vigente(uuid,uuid)', 'execute') then
        raise exception 'MSG-010: superficie de verificacao exposta.';
    end if;
end;
$$;
