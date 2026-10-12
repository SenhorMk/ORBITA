-- 74_reconciliacao_de_conta_a_pagar.sql
-- Forward-only. PRE-002: sair de `indeterminada` só com prova, e dar à baixa
-- (quitação) a mesma identidade durável que a criação ganhou na migration 73.
--
-- NUNCA APLICADA REMOTAMENTE: a revisão independente do PR #109 a corrigiu no
-- lugar (quitação solicitada durável, conta remota única por operação,
-- confirmação manual auditável), como a migration 59 em situação igual.
--
-- A REGRA
-- Ausência de confirmação não é ausência do efeito, e busca vazia não prova que
-- a conta não foi criada. Por isso esta migration NÃO abre nenhuma saída de
-- `indeterminada` para `nao_enviada`, `recusada` ou um novo POST. A única saída
-- nova é `indeterminada → confirmada`, e o gatilho só a aceita se, na mesma
-- transação, existir um recibo de reconciliação que aponte a mesma conta remota.
--
-- O QUE PROVA A CONTA
-- O OpenAPI oficial do Bling (`openapi-Dw6cY8yQ.json`, 09/10/2026) não tem
-- idempotência em `POST /contas/pagar` nem filtro por referência em
-- `GET /contas/pagar`. Tem, porém, `numeroDocumento` ("número para controle
-- interno da empresa"), gravável no POST e devolvido em `GET /contas/pagar/{id}`.
-- A partir desta migration, cada tentativa nova carrega uma referência opaca do
-- ORBITA (`numero_documento`) que vai nesse campo. Tentativas criadas antes não
-- têm referência: para elas nenhuma conciliação automática é prova suficiente.

-- ---------------------------------------------------------------------------
-- 1. A referência enviada ao Bling.
-- ---------------------------------------------------------------------------
alter table public.tentativas_conta_pagar
    add column if not exists numero_documento text
        check (numero_documento ~ '^ORB-[0-9A-F]{16}$');

-- Única por organização: duas tentativas nunca carregam a mesma referência, e
-- uma conta remota com ela só pode ser de uma tentativa.
create unique index if not exists uq_tentativas_conta_pagar_numero_documento
    on public.tentativas_conta_pagar (organizacao_id, numero_documento)
    where numero_documento is not null;

-- A quitação pedida no lançamento ("pago: true"). Sem isto, uma criação com ACK
-- perdido, confirmada depois por reconciliação, esquecia que a despesa devia ser
-- quitada: o digest não permite reconstruir o pedido.
alter table public.tentativas_conta_pagar
    add column if not exists quitacao_solicitada boolean not null default false;

-- Uma conta remota nunca serve a duas operações da organização — nem por
-- reconciliação automática, nem por confirmação manual.
create unique index if not exists uq_tentativas_conta_pagar_conta_remota
    on public.tentativas_conta_pagar (organizacao_id, bling_conta_id)
    where bling_conta_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Recibos de reconciliação — append-only.
--
-- Responde "quem decidiu, com qual evidência e quando". Sem corpo do provedor,
-- sem texto livre: só identificadores, códigos e números.
-- ---------------------------------------------------------------------------
create table if not exists public.reconciliacoes_conta_pagar (
    id               uuid primary key default gen_random_uuid(),
    organizacao_id   uuid not null references public.organizacoes(id) on delete cascade,
    tentativa_id     uuid not null references public.tentativas_conta_pagar(id) on delete cascade,
    alvo             text not null check (alvo in ('criacao', 'baixa')),
    ator_id          uuid not null,
    correlation_id   text not null check (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    metodo           text not null check (metodo in (
                         'referencia_no_numero_documento', 'leitura_por_id', 'leitura_de_borderos',
                         'confirmacao_manual', 'declaracao_do_operador', 'sem_metodo_seguro')),
    resultado        text not null check (resultado in ('confirmada', 'ja_confirmada', 'revisao_manual', 'divergente')),
    motivo           text check (motivo ~ '^[a-z0-9_]{1,64}$'),
    bling_conta_id   text check (bling_conta_id ~ '^[0-9]+$'),
    bordero_id       text check (bordero_id ~ '^[0-9]+$'),
    situacao_remota  smallint check (situacao_remota between 1 and 7),
    candidatos       integer check (candidatos >= 0),
    estado_antes     text not null,
    epoca_observada  integer not null check (epoca_observada >= 1),
    created_at       timestamptz not null default now(),
    constraint ck_reconciliacao_confirmada_tem_conta
        check (resultado not in ('confirmada', 'ja_confirmada') or bling_conta_id is not null),
    -- Baixa só se confirma com o borderô que a prova (PRE-002).
    constraint ck_reconciliacoes_conta_pagar_baixa_tem_bordero
        check (alvo <> 'baixa' or resultado not in ('confirmada', 'ja_confirmada') or bordero_id is not null)
);

create index if not exists idx_reconciliacoes_conta_pagar_tentativa
    on public.reconciliacoes_conta_pagar (tentativa_id, created_at desc);
create index if not exists idx_reconciliacoes_conta_pagar_org
    on public.reconciliacoes_conta_pagar (organizacao_id);

revoke all on public.reconciliacoes_conta_pagar from public, anon, authenticated;
grant select, insert on public.reconciliacoes_conta_pagar to service_role;
alter table public.reconciliacoes_conta_pagar enable row level security;

create or replace function public.fn_reconciliacao_conta_pagar_imutavel()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    raise exception 'Recibo de reconciliacao e append-only.' using errcode = '23514';
end;
$$;

revoke all on function public.fn_reconciliacao_conta_pagar_imutavel() from public, anon, authenticated;

drop trigger if exists tg_reconciliacoes_conta_pagar_imutavel on public.reconciliacoes_conta_pagar;
create trigger tg_reconciliacoes_conta_pagar_imutavel
    before update or delete on public.reconciliacoes_conta_pagar
    for each row execute function public.fn_reconciliacao_conta_pagar_imutavel();

-- ---------------------------------------------------------------------------
-- 3. A máquina de estados da criação, com a saída comprovada.
--
-- Mesmas regras da migration 73, mais:
-- - `numero_documento` entra na identidade imutável;
-- - `indeterminada → confirmada` só com recibo `confirmada` desta tentativa e
--   desta conta remota.
-- ---------------------------------------------------------------------------
create or replace function public.fn_tentativa_conta_pagar_transicao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.organizacao_id is distinct from old.organizacao_id
       or new.chave is distinct from old.chave
       or new.digest is distinct from old.digest
       or new.valor is distinct from old.valor
       or new.data_vencimento is distinct from old.data_vencimento
       or new.numero_documento is distinct from old.numero_documento
       or new.quitacao_solicitada is distinct from old.quitacao_solicitada
       or new.created_at is distinct from old.created_at then
        raise exception 'A identidade de uma tentativa de conta a pagar e imutavel.' using errcode = '23514';
    end if;

    if old.estado = 'em_voo' and new.estado in ('nao_enviada', 'confirmada', 'recusada', 'indeterminada')
       and new.epoca = old.epoca then
        return new;
    end if;

    if old.estado = 'nao_enviada' and new.estado = 'em_voo' and new.epoca = old.epoca + 1 then
        return new;
    end if;

    if old.estado = 'confirmada' and new.estado = 'confirmada'
       and old.titulo_id is null and new.titulo_id is not null
       and new.bling_conta_id = old.bling_conta_id and new.epoca = old.epoca then
        return new;
    end if;

    -- PRE-002: a única saída de `indeterminada`, e só com recibo.
    if old.estado = 'indeterminada' and new.estado = 'confirmada' and new.epoca = old.epoca
       and exists (
           select 1 from public.reconciliacoes_conta_pagar r
            where r.tentativa_id = new.id
              and r.organizacao_id = new.organizacao_id
              and r.alvo = 'criacao'
              and r.resultado = 'confirmada'
              and r.bling_conta_id = new.bling_conta_id
       ) then
        return new;
    end if;

    raise exception 'Transicao invalida de tentativa de conta a pagar: % -> %.', old.estado, new.estado
        using errcode = '23514';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A reivindicação passa a gravar a referência enviada ao Bling.
--
-- Os parâmetros novos têm default: a chamada da versão anterior (sete argumentos
-- nomeados) continua resolvendo para esta função durante o deploy.
-- ---------------------------------------------------------------------------
drop function if exists public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint);

create or replace function public.reivindicar_tentativa_conta_pagar(
    p_organizacao_id uuid,
    p_chave uuid,
    p_digest text,
    p_valor numeric,
    p_data_vencimento date,
    p_data_emissao date,
    p_contato_bling_id bigint,
    p_numero_documento text default null,
    p_quitacao_solicitada boolean default false
)
returns table (
    tentativa_id uuid,
    estado text,
    epoca integer,
    bling_conta_id text,
    titulo_id uuid,
    contato_bling_id bigint,
    desfecho text,
    chave_pendente uuid,
    numero_documento text,
    quitacao_solicitada boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_id uuid;
    v_existente record;
    v_epoca integer;
    v_chave_pendente uuid;
begin
    if p_organizacao_id is null or p_chave is null or p_digest is null
       or p_valor is null or p_data_vencimento is null or p_data_emissao is null then
        raise exception 'Organizacao, chave, digest, valor e datas sao obrigatorios.' using errcode = '22023';
    end if;

    begin
        insert into public.tentativas_conta_pagar
            (organizacao_id, chave, digest, valor, data_vencimento, data_emissao, contato_bling_id, numero_documento,
             quitacao_solicitada)
        values
            (p_organizacao_id, p_chave, p_digest, p_valor, p_data_vencimento, p_data_emissao, p_contato_bling_id,
             p_numero_documento, coalesce(p_quitacao_solicitada, false))
        on conflict on constraint uq_tentativas_conta_pagar_org_chave do nothing
        returning id into v_id;
    exception
        when unique_violation then
            -- Pendência idêntica (índice da 73) ou, em tese, referência
            -- repetida. Sem chave pendente a apontar, quem chama falha fechado.
            select t.chave into v_chave_pendente
            from public.tentativas_conta_pagar t
            where t.organizacao_id = p_organizacao_id
              and t.digest = p_digest
              and t.estado in ('em_voo', 'indeterminada')
            limit 1;
            return query select null::uuid, null::text, null::integer, null::text, null::uuid, null::bigint,
                                'pendencia_identica'::text, v_chave_pendente, null::text, null::boolean;
            return;
    end;

    if v_id is not null then
        return query select v_id, 'em_voo'::text, 1, null::text, null::uuid, p_contato_bling_id,
                            'nova'::text, null::uuid, p_numero_documento, coalesce(p_quitacao_solicitada, false);
        return;
    end if;

    select t.id, t.estado, t.epoca, t.digest, t.bling_conta_id, t.titulo_id, t.contato_bling_id, t.numero_documento,
           t.quitacao_solicitada
    into v_existente
    from public.tentativas_conta_pagar t
    where t.organizacao_id = p_organizacao_id
      and t.chave = p_chave
    for update;

    if v_existente.digest is distinct from p_digest then
        return query select null::uuid, null::text, null::integer, null::text, null::uuid, null::bigint,
                            'conflito_de_conteudo'::text, null::uuid, null::text, null::boolean;
        return;
    end if;

    if v_existente.estado = 'nao_enviada' then
        begin
            update public.tentativas_conta_pagar t
            set estado = 'em_voo', epoca = t.epoca + 1, data_emissao = p_data_emissao, motivo = null
            where t.id = v_existente.id
            returning t.epoca into v_epoca;
        exception
            when unique_violation then
                select t.chave into v_chave_pendente
                from public.tentativas_conta_pagar t
                where t.organizacao_id = p_organizacao_id
                  and t.digest = p_digest
                  and t.estado in ('em_voo', 'indeterminada')
                limit 1;
                return query select null::uuid, null::text, null::integer, null::text, null::uuid, null::bigint,
                                    'pendencia_identica'::text, v_chave_pendente, null::text, null::boolean;
                return;
        end;
        -- A referência é a gravada na primeira reivindicação: reabrir não a troca.
        return query select v_existente.id, 'em_voo'::text, v_epoca, null::text, null::uuid,
                            v_existente.contato_bling_id, 'reaberta'::text, null::uuid, v_existente.numero_documento,
                            v_existente.quitacao_solicitada;
        return;
    end if;

    return query select v_existente.id, v_existente.estado, v_existente.epoca, v_existente.bling_conta_id,
                        v_existente.titulo_id, v_existente.contato_bling_id, 'repetida'::text, null::uuid,
                        v_existente.numero_documento, v_existente.quitacao_solicitada;
end;
$$;

revoke all on function public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint, text, boolean)
    from public, anon, authenticated;
grant execute on function public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint, text, boolean)
    to service_role;

-- ---------------------------------------------------------------------------
-- 5. A baixa: identidade durável própria, separada da criação.
--
-- Uma intenção de baixa por conta criada (`unique (tentativa_id)`): repetir a
-- quitação reutiliza a mesma intenção, nunca abre outra invisível.
-- ---------------------------------------------------------------------------
create table if not exists public.baixas_conta_pagar (
    id              uuid primary key default gen_random_uuid(),
    organizacao_id  uuid not null references public.organizacoes(id) on delete cascade,
    tentativa_id    uuid not null references public.tentativas_conta_pagar(id) on delete cascade,
    bling_conta_id  text not null check (bling_conta_id ~ '^[0-9]+$'),
    estado          text not null default 'em_voo'
                     check (estado in ('em_voo', 'nao_enviada', 'confirmada', 'recusada', 'indeterminada')),
    epoca           integer not null default 1 check (epoca >= 1),
    data_baixa      date not null,
    bordero_id      text check (bordero_id ~ '^[0-9]+$'),
    motivo          text check (motivo ~ '^[a-z0-9_]{1,64}$'),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint uq_baixas_conta_pagar_tentativa unique (tentativa_id),
    -- Nem o desfecho direto do POST confirma uma baixa sem o borderô.
    constraint ck_baixas_conta_pagar_confirmada_tem_bordero
        check (estado <> 'confirmada' or bordero_id is not null)
);

create index if not exists idx_baixas_conta_pagar_org_estado
    on public.baixas_conta_pagar (organizacao_id, estado);

revoke all on public.baixas_conta_pagar from public, anon, authenticated;
grant select, insert, update on public.baixas_conta_pagar to service_role;
alter table public.baixas_conta_pagar enable row level security;

drop trigger if exists tg_baixas_conta_pagar_updated_at on public.baixas_conta_pagar;
create trigger tg_baixas_conta_pagar_updated_at
    before update on public.baixas_conta_pagar
    for each row execute function public.fn_set_updated_at();

-- Só nasce de uma criação confirmada, desta organização e desta conta remota.
create or replace function public.fn_baixa_conta_pagar_nasce_de_confirmada()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if not exists (
        select 1 from public.tentativas_conta_pagar t
         where t.id = new.tentativa_id
           and t.organizacao_id = new.organizacao_id
           and t.estado = 'confirmada'
           and t.bling_conta_id = new.bling_conta_id
    ) then
        raise exception 'Baixa so existe para conta a pagar confirmada desta organizacao.' using errcode = '23514';
    end if;
    return new;
end;
$$;

revoke all on function public.fn_baixa_conta_pagar_nasce_de_confirmada() from public, anon, authenticated;

drop trigger if exists tg_baixas_conta_pagar_nasce_de_confirmada on public.baixas_conta_pagar;
create trigger tg_baixas_conta_pagar_nasce_de_confirmada
    before insert on public.baixas_conta_pagar
    for each row execute function public.fn_baixa_conta_pagar_nasce_de_confirmada();

create or replace function public.fn_baixa_conta_pagar_transicao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.organizacao_id is distinct from old.organizacao_id
       or new.tentativa_id is distinct from old.tentativa_id
       or new.bling_conta_id is distinct from old.bling_conta_id
       or new.created_at is distinct from old.created_at then
        raise exception 'A identidade de uma baixa de conta a pagar e imutavel.' using errcode = '23514';
    end if;

    if old.estado = 'em_voo' and new.estado in ('nao_enviada', 'confirmada', 'recusada', 'indeterminada')
       and new.epoca = old.epoca then
        return new;
    end if;

    if old.estado = 'nao_enviada' and new.estado = 'em_voo' and new.epoca = old.epoca + 1 then
        return new;
    end if;

    -- Baixa ambígua não vira nova baixa: só sai para `confirmada`, com recibo.
    if old.estado = 'indeterminada' and new.estado = 'confirmada' and new.epoca = old.epoca
       and exists (
           select 1 from public.reconciliacoes_conta_pagar r
            where r.tentativa_id = new.tentativa_id
              and r.organizacao_id = new.organizacao_id
              and r.alvo = 'baixa'
              and r.resultado = 'confirmada'
              and r.bling_conta_id = new.bling_conta_id
       ) then
        return new;
    end if;

    raise exception 'Transicao invalida de baixa de conta a pagar: % -> %.', old.estado, new.estado
        using errcode = '23514';
end;
$$;

revoke all on function public.fn_baixa_conta_pagar_transicao() from public, anon, authenticated;

drop trigger if exists tg_baixas_conta_pagar_transicao on public.baixas_conta_pagar;
create trigger tg_baixas_conta_pagar_transicao
    before update on public.baixas_conta_pagar
    for each row execute function public.fn_baixa_conta_pagar_transicao();

-- desfecho: nova | reaberta (era nao_enviada) | repetida (não envia nada).
create or replace function public.reivindicar_baixa_conta_pagar(
    p_organizacao_id uuid,
    p_tentativa_id uuid,
    p_bling_conta_id text,
    p_data_baixa date
)
returns table (baixa_id uuid, estado text, epoca integer, desfecho text)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_id uuid;
    v_existente record;
    v_epoca integer;
begin
    if p_organizacao_id is null or p_tentativa_id is null or p_bling_conta_id is null or p_data_baixa is null then
        raise exception 'Organizacao, tentativa, conta e data sao obrigatorias.' using errcode = '22023';
    end if;

    insert into public.baixas_conta_pagar (organizacao_id, tentativa_id, bling_conta_id, data_baixa)
    values (p_organizacao_id, p_tentativa_id, p_bling_conta_id, p_data_baixa)
    on conflict on constraint uq_baixas_conta_pagar_tentativa do nothing
    returning id into v_id;

    if v_id is not null then
        return query select v_id, 'em_voo'::text, 1, 'nova'::text;
        return;
    end if;

    select b.id, b.estado, b.epoca into v_existente
    from public.baixas_conta_pagar b
    where b.tentativa_id = p_tentativa_id and b.organizacao_id = p_organizacao_id
    for update;

    if not found then
        raise exception 'Baixa nao encontrada nesta organizacao.' using errcode = 'P0002';
    end if;

    if v_existente.estado = 'nao_enviada' then
        update public.baixas_conta_pagar b
        set estado = 'em_voo', epoca = b.epoca + 1, data_baixa = p_data_baixa, motivo = null
        where b.id = v_existente.id
        returning b.epoca into v_epoca;
        return query select v_existente.id, 'em_voo'::text, v_epoca, 'reaberta'::text;
        return;
    end if;

    return query select v_existente.id, v_existente.estado, v_existente.epoca, 'repetida'::text;
end;
$$;

revoke all on function public.reivindicar_baixa_conta_pagar(uuid, uuid, text, date) from public, anon, authenticated;
grant execute on function public.reivindicar_baixa_conta_pagar(uuid, uuid, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Registrar a reconciliação: recibo e transição na MESMA transação.
--
-- A leitura no Bling acontece fora daqui (sem transação aberta na rede). Esta
-- função trava a tentativa (`FOR UPDATE`), decide contra o estado já
-- commitado e grava o recibo antes da transição — o gatilho exige o recibo.
-- Duas reconciliações concorrentes se serializam na trava: a segunda vê o
-- desfecho da primeira e grava `ja_confirmada` ou `divergente`, sem mudar nada.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_reconciliacao_conta_pagar(
    p_organizacao_id uuid,
    p_chave uuid,
    p_alvo text,
    p_ator_id uuid,
    p_correlation_id text,
    p_metodo text,
    p_resultado text,
    p_motivo text,
    p_bling_conta_id text,
    p_bordero_id text,
    p_situacao_remota integer,
    p_candidatos integer
)
returns table (resultado text, motivo text, estado text, tentativa_id uuid, bling_conta_id text, titulo_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_t record;
    v_b record;
    v_resultado text;
begin
    if p_organizacao_id is null or p_chave is null or p_ator_id is null
       or p_alvo not in ('criacao', 'baixa') or p_resultado not in ('confirmada', 'revisao_manual') then
        raise exception 'Parametros de reconciliacao invalidos.' using errcode = '22023';
    end if;
    if p_resultado = 'confirmada' and p_bling_conta_id is null then
        raise exception 'Confirmacao exige a conta remota.' using errcode = '22023';
    end if;
    -- Método, evidência e motivo coerentes com o desfecho pedido.
    if (p_resultado = 'confirmada') = (p_motivo is not null) then
        raise exception 'Confirmacao nao tem motivo; revisao manual exige um.' using errcode = '22023';
    end if;
    if p_resultado = 'confirmada' and p_alvo = 'baixa'
       and (p_bordero_id is null or p_metodo is distinct from 'leitura_de_borderos') then
        raise exception 'Baixa so se confirma pelo borderô que a prova.' using errcode = '22023';
    end if;
    -- O banco não conhece o Bling: confere só que o registrado é coerente
    -- (a conta lida estava `Pago`). A autoria é decidida antes, no servidor.
    if p_resultado = 'confirmada' and p_alvo = 'baixa' and p_situacao_remota is distinct from 2 then
        raise exception 'Baixa so se confirma com a conta registrada como paga.' using errcode = '22023';
    end if;
    if p_resultado = 'confirmada' and p_alvo = 'criacao'
       and p_metodo not in ('referencia_no_numero_documento', 'confirmacao_manual', 'declaracao_do_operador') then
        raise exception 'Metodo incompativel com a confirmacao da criacao.' using errcode = '22023';
    end if;

    select t.id, t.estado, t.epoca, t.bling_conta_id, t.titulo_id
    into v_t
    from public.tentativas_conta_pagar t
    where t.organizacao_id = p_organizacao_id and t.chave = p_chave
    for update;
    if not found then
        raise exception 'Operacao nao encontrada nesta organizacao.' using errcode = 'P0002';
    end if;

    if p_alvo = 'criacao' then
        if p_resultado = 'confirmada' then
            -- Serializa as confirmações da MESMA conta remota em operações
            -- diferentes: a segunda espera e vê a primeira já gravada.
            perform pg_advisory_xact_lock(hashtextextended(p_organizacao_id::text || ':conta:' || p_bling_conta_id, 0));
        end if;
        if p_resultado = 'revisao_manual' then
            v_resultado := 'revisao_manual';
        elsif exists (
            select 1 from public.tentativas_conta_pagar o
             where o.organizacao_id = p_organizacao_id
               and o.bling_conta_id = p_bling_conta_id
               and o.id <> v_t.id
        ) then
            -- A conta remota já é de outra operação: confirmar aqui ligaria
            -- duas operações à mesma conta.
            v_resultado := 'divergente';
            p_motivo := 'conta_de_outra_operacao';
        elsif v_t.estado in ('em_voo', 'indeterminada') then
            v_resultado := 'confirmada';
        elsif v_t.estado = 'confirmada' and v_t.bling_conta_id = p_bling_conta_id then
            v_resultado := 'ja_confirmada';
        else
            v_resultado := 'divergente';
        end if;

        insert into public.reconciliacoes_conta_pagar
            (organizacao_id, tentativa_id, alvo, ator_id, correlation_id, metodo, resultado, motivo,
             bling_conta_id, bordero_id, situacao_remota, candidatos, estado_antes, epoca_observada)
        values
            (p_organizacao_id, v_t.id, 'criacao', p_ator_id, p_correlation_id, p_metodo, v_resultado, p_motivo,
             p_bling_conta_id, p_bordero_id, p_situacao_remota, p_candidatos, v_t.estado, v_t.epoca);

        if v_resultado = 'confirmada' then
            update public.tentativas_conta_pagar t
            set estado = 'confirmada', bling_conta_id = p_bling_conta_id
            where t.id = v_t.id;
            return query select v_resultado, p_motivo, 'confirmada'::text, v_t.id, p_bling_conta_id, v_t.titulo_id;
            return;
        end if;
        return query select v_resultado, p_motivo, v_t.estado, v_t.id, v_t.bling_conta_id, v_t.titulo_id;
        return;
    end if;

    select b.id, b.estado, b.epoca, b.bling_conta_id
    into v_b
    from public.baixas_conta_pagar b
    where b.tentativa_id = v_t.id and b.organizacao_id = p_organizacao_id
    for update;
    if not found then
        raise exception 'Baixa nao encontrada nesta organizacao.' using errcode = 'P0002';
    end if;

    if p_resultado = 'revisao_manual' then
        v_resultado := 'revisao_manual';
    elsif p_bling_conta_id is distinct from v_b.bling_conta_id then
        v_resultado := 'divergente';
    elsif v_b.estado in ('em_voo', 'indeterminada') then
        v_resultado := 'confirmada';
    elsif v_b.estado = 'confirmada' then
        v_resultado := 'ja_confirmada';
    else
        v_resultado := 'divergente';
    end if;

    insert into public.reconciliacoes_conta_pagar
        (organizacao_id, tentativa_id, alvo, ator_id, correlation_id, metodo, resultado, motivo,
         bling_conta_id, bordero_id, situacao_remota, candidatos, estado_antes, epoca_observada)
    values
        (p_organizacao_id, v_t.id, 'baixa', p_ator_id, p_correlation_id, p_metodo, v_resultado, p_motivo,
         p_bling_conta_id, p_bordero_id, p_situacao_remota, p_candidatos, v_b.estado, v_b.epoca);

    if v_resultado = 'confirmada' then
        update public.baixas_conta_pagar b
        set estado = 'confirmada', bordero_id = coalesce(p_bordero_id, b.bordero_id)
        where b.id = v_b.id;
        return query select v_resultado, p_motivo, 'confirmada'::text, v_t.id, v_b.bling_conta_id, v_t.titulo_id;
        return;
    end if;
    return query select v_resultado, p_motivo, v_b.estado, v_t.id, v_b.bling_conta_id, v_t.titulo_id;
end;
$$;

revoke all on function public.registrar_reconciliacao_conta_pagar(
    uuid, uuid, text, uuid, text, text, text, text, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.registrar_reconciliacao_conta_pagar(
    uuid, uuid, text, uuid, text, text, text, text, text, text, integer, integer
) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Listar as pendências NO BANCO, sobre todas as operações da organização.
--
-- Mesma regra de `pendenciaDaOperacao` (reconciliacaoDeContaPagar.ts). Uma
-- janela de "mais recentes" filtrada depois esconderia uma pendência antiga;
-- aqui o filtro vem antes do limite, `total` conta todas (independe do cursor)
-- e o cursor `(created_at, chave)` alcança cada uma, página a página, sem
-- repetir nem pular. O título é procurado NA MESMA organização: um vínculo que
-- não o encontra é inconsistência e aparece.
-- ---------------------------------------------------------------------------
create or replace function public.listar_pendencias_conta_pagar(
    p_organizacao_id uuid,
    p_limite integer default 100,
    p_apos_criada_em timestamptz default null,
    p_apos_chave uuid default null
)
returns table (tentativa_id uuid, chave uuid, created_at timestamptz, total bigint)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
    -- Cursor estável: (created_at, chave), as duas partes ou nenhuma. A chave é
    -- única na organização e desempata o mesmo instante.
    if (p_apos_criada_em is null) <> (p_apos_chave is null) then
        raise exception 'Cursor incompleto.' using errcode = '22023';
    end if;

    return query
    with pendentes as (
        select t.id, t.chave, t.created_at
          from public.tentativas_conta_pagar t
          left join public.titulos_financeiros tf
            on tf.id = t.titulo_id and tf.organizacao_id = t.organizacao_id
          left join public.baixas_conta_pagar b
            on b.tentativa_id = t.id and b.organizacao_id = t.organizacao_id
         where t.organizacao_id = p_organizacao_id
           and (
                t.estado in ('em_voo', 'indeterminada')
             or (t.estado = 'confirmada' and (
                    t.titulo_id is null
                 or tf.id is null
                 or tf.situacao not in ('aberto', 'pago', 'cancelado', 'estornado')
                 -- O Bling diz `Pago` e o saldo não comprovou: o título ficou aberto.
                 or (tf.situacao = 'aberto' and tf.situacao_bling = 2)
                 or (tf.situacao in ('cancelado', 'estornado') and (t.quitacao_solicitada or b.id is not null))
                 or b.estado in ('em_voo', 'indeterminada')
                 or (tf.situacao = 'aberto' and (
                        b.estado in ('confirmada', 'recusada')
                     or (t.quitacao_solicitada and (b.id is null or b.estado = 'nao_enviada'))))
             ))
           )
    )
    select p.id, p.chave, p.created_at, (select count(*) from pendentes)
      from pendentes p
     where p_apos_criada_em is null or (p.created_at, p.chave) < (p_apos_criada_em, p_apos_chave)
     order by p.created_at desc, p.chave desc
     limit greatest(1, least(coalesce(p_limite, 100), 500));
end;
$$;

revoke all on function public.listar_pendencias_conta_pagar(uuid, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.listar_pendencias_conta_pagar(uuid, integer, timestamptz, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. O título de uma conta do PRE-002 só vira pago com a comprovação do servidor.
--
-- A sincronização financeira grava `situacao = 'pago'` quando o Bling diz Pago,
-- sem saldo; a reconciliação deixa o título aberto enquanto o saldo não
-- comprova (`pagamento_nao_comprovado`). Uma releitura no servidor seguida de
-- escrita não basta (a sincronização pode gravar no meio): a regra fica no
-- próprio UPDATE. Um título a pagar vinculado a uma operação do PRE-002, ou
-- cuja conta remota já é de uma, não passa a pago por gravação comum — o resto
-- da linha é gravado normalmente. Só `marcar_titulo_pago_conta_pagar`, que o
-- servidor chama depois de comprovar o pagamento, marca, e a comprovação vale
-- só para aquele título, naquela transação. Títulos a receber, contas fora do
-- PRE-002 e os estados terminais (migration 68) seguem como antes.
-- ---------------------------------------------------------------------------
create or replace function public.fn_titulo_conta_pagar_pago_so_comprovado()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.situacao = 'pago' and old.situacao is distinct from 'pago' and old.tipo = 'pagar'
       and coalesce(current_setting('orbita.titulo_pago_comprovado', true), '') is distinct from old.id::text
       and exists (
           select 1 from public.tentativas_conta_pagar t
            where t.organizacao_id = old.organizacao_id
              and (t.titulo_id = old.id or (old.bling_id is not null and t.bling_conta_id = old.bling_id::text))
       ) then
        new.situacao := old.situacao;
        new.data_pagamento := old.data_pagamento;
    end if;
    return new;
end;
$$;

revoke all on function public.fn_titulo_conta_pagar_pago_so_comprovado() from public, anon, authenticated;

drop trigger if exists tg_titulo_conta_pagar_pago_so_comprovado on public.titulos_financeiros;
create trigger tg_titulo_conta_pagar_pago_so_comprovado
    before update on public.titulos_financeiros
    for each row execute function public.fn_titulo_conta_pagar_pago_so_comprovado();

create or replace function public.marcar_titulo_pago_conta_pagar(
    p_organizacao_id uuid,
    p_titulo_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_linhas integer;
begin
    if p_organizacao_id is null or p_titulo_id is null then
        raise exception 'Organizacao e titulo sao obrigatorios.' using errcode = '22023';
    end if;
    perform set_config('orbita.titulo_pago_comprovado', p_titulo_id::text, true);
    update public.titulos_financeiros tf
       set situacao = 'pago'
     where tf.id = p_titulo_id
       and tf.organizacao_id = p_organizacao_id
       and tf.situacao = 'aberto'
       and exists (select 1 from public.tentativas_conta_pagar t
                    where t.organizacao_id = p_organizacao_id and t.titulo_id = p_titulo_id);
    get diagnostics v_linhas = row_count;
    perform set_config('orbita.titulo_pago_comprovado', '', true);
    return v_linhas = 1;
end;
$$;

revoke all on function public.marcar_titulo_pago_conta_pagar(uuid, uuid) from public, anon, authenticated;
grant execute on function public.marcar_titulo_pago_conta_pagar(uuid, uuid) to service_role;
