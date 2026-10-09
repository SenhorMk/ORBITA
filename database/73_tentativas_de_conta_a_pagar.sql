-- 73_tentativas_de_conta_a_pagar.sql
-- Forward-only. PRE-001: a intenção de criar uma conta a pagar no Bling existe,
-- durável e por organização, ANTES do POST.
--
-- O DEFEITO
-- `POST /api/financeiro` (modo contábil) chamava `POST /contas/pagar` e só
-- gravava algo no ORBITA depois da resposta. O OpenAPI oficial do Bling não
-- oferece chave de idempotência para esse POST. Se o Bling criava a conta e a
-- resposta se perdia, o ORBITA respondia erro, e a nova tentativa do usuário
-- criava uma SEGUNDA conta a pagar real.
--
-- A CORREÇÃO
-- A chave da operação nasce no navegador, antes da rede, e é reivindicada aqui
-- antes de qualquer chamada ao Bling. A mesma chave com o mesmo digest é a
-- MESMA operação: devolve o estado gravado e não reenvia. A mesma chave com
-- outro digest é conflito, nunca reaproveitamento. "Não recebi confirmação"
-- vira `indeterminada`, que bloqueia novos envios da mesma intenção.
--
-- Estados:
--   em_voo         reivindicada; o POST pode estar acontecendo, ou a requisição
--                  morreu no meio — os dois casos bloqueiam um novo envio
--   nao_enviada    provado que nenhum POST saiu; a MESMA chave pode reabrir
--   confirmada     o Bling devolveu o id da conta (bling_conta_id)
--   recusada       recusa definitiva da requisição, comprovada pelo contrato
--   indeterminada  o POST pode ter criado a conta; só a reconciliação (PRE-002)
--                  decide. Nesta migration, nenhuma transição sai dele.
--
-- Fora desta migration: a reconciliação com o Bling (PRE-002). Por isso a
-- tentativa guarda o mínimo que essa busca vai precisar — contato, valor,
-- vencimento e emissão —, e nada de texto livre: a descrição entra só no digest.

-- ---------------------------------------------------------------------------
-- 1. A tabela.
-- ---------------------------------------------------------------------------
create table if not exists public.tentativas_conta_pagar (
    id                uuid primary key default gen_random_uuid(),
    organizacao_id    uuid not null references public.organizacoes(id) on delete cascade,
    -- A `operation_ref` devolvida à API. Gerada no cliente antes da rede.
    chave             uuid not null,
    -- SHA-256 (hex) do pedido de despesa canônico, sem a chave.
    digest            text not null check (digest ~ '^[0-9a-f]{64}$'),
    estado            text not null default 'em_voo'
                       check (estado in ('em_voo', 'nao_enviada', 'confirmada', 'recusada', 'indeterminada')),
    -- Época do dono: só quem reivindicou nesta época grava o desfecho.
    -- Reabrir uma `nao_enviada` avança a época.
    epoca             integer not null default 1 check (epoca >= 1),
    valor             numeric(10, 2) not null check (valor > 0),
    data_vencimento   date not null,
    data_emissao      date not null,
    contato_bling_id  bigint check (contato_bling_id > 0),
    bling_conta_id    text check (bling_conta_id ~ '^[0-9]+$'),
    titulo_id         uuid references public.titulos_financeiros(id) on delete set null,
    -- Código curto do desfecho (`sem_resposta`, `erro_do_provedor`, ...),
    -- nunca texto do provedor.
    motivo            text check (motivo ~ '^[a-z0-9_]{1,64}$'),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint uq_tentativas_conta_pagar_org_chave unique (organizacao_id, chave),
    constraint ck_tentativas_conta_pagar_confirmada_tem_id
        check ((estado = 'confirmada') = (bling_conta_id is not null)),
    constraint ck_tentativas_conta_pagar_titulo_so_confirmada
        check (titulo_id is null or estado = 'confirmada')
);

-- Duas chaves DIFERENTES para o MESMO lançamento não podem estar pendentes ao
-- mesmo tempo: a segunda bloqueia no índice até a primeira decidir e então
-- falha com 23505, que a reivindicação trata. Cobre o recarregar da página
-- (o navegador perdeu a chave) e outro dispositivo. `nao_enviada`,
-- `confirmada` e `recusada` saem do índice: um lançamento idêntico depois de
-- um desfecho conhecido é uma operação nova legítima.
create unique index if not exists uq_tentativas_conta_pagar_pendencia
    on public.tentativas_conta_pagar (organizacao_id, digest)
    where estado in ('em_voo', 'indeterminada');

create index if not exists idx_tentativas_conta_pagar_titulo
    on public.tentativas_conta_pagar (titulo_id)
    where titulo_id is not null;

-- Só o servidor (service_role) lê e escreve. O navegador não precisa da
-- tabela: a API devolve o estado. Sem DELETE: tentativa é histórico.
revoke all on public.tentativas_conta_pagar from public, anon, authenticated;
grant select, insert, update on public.tentativas_conta_pagar to service_role;

-- RLS ligada e sem política: nenhum papel além dos que a ignoram enxerga linha.
alter table public.tentativas_conta_pagar enable row level security;

drop trigger if exists tg_tentativas_conta_pagar_updated_at on public.tentativas_conta_pagar;
create trigger tg_tentativas_conta_pagar_updated_at
    before update on public.tentativas_conta_pagar
    for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. A máquina de estados, imposta pelo banco.
--
-- Mesmo o service_role, que ignora RLS, não consegue pular estado. Em
-- particular `indeterminada` não vira `recusada` (nem nada): uma resposta
-- perdida nunca passa a ser tratada como recusa. O PRE-002 abre a saída
-- desse estado numa migration própria, com prova da reconciliação.
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
       or new.created_at is distinct from old.created_at then
        raise exception 'A identidade de uma tentativa de conta a pagar e imutavel.' using errcode = '23514';
    end if;

    -- Desfecho de quem reivindicou: só sai de em_voo, na mesma época.
    if old.estado = 'em_voo' and new.estado in ('nao_enviada', 'confirmada', 'recusada', 'indeterminada')
       and new.epoca = old.epoca then
        return new;
    end if;

    -- Reabrir uma tentativa comprovadamente não enviada: novo dono.
    if old.estado = 'nao_enviada' and new.estado = 'em_voo' and new.epoca = old.epoca + 1 then
        return new;
    end if;

    -- Confirmada só ganha o vínculo com o título local, uma vez.
    if old.estado = 'confirmada' and new.estado = 'confirmada'
       and old.titulo_id is null and new.titulo_id is not null
       and new.bling_conta_id = old.bling_conta_id and new.epoca = old.epoca then
        return new;
    end if;

    raise exception 'Transicao invalida de tentativa de conta a pagar: % -> %.', old.estado, new.estado
        using errcode = '23514';
end;
$$;

revoke all on function public.fn_tentativa_conta_pagar_transicao() from public, anon, authenticated;

drop trigger if exists tg_tentativas_conta_pagar_transicao on public.tentativas_conta_pagar;
create trigger tg_tentativas_conta_pagar_transicao
    before update on public.tentativas_conta_pagar
    for each row execute function public.fn_tentativa_conta_pagar_transicao();

-- ---------------------------------------------------------------------------
-- 3. Reivindicação atômica.
--
-- `security invoker`: o único chamador é o service_role, que já tem os
-- privilégios da tabela. A organização chega como argumento porque o servidor
-- a deriva da sessão verificada; toda leitura e escrita aqui a filtra.
--
-- desfecho:
--   nova                 primeira vez desta chave; quem chamou é o dono (época 1)
--   reaberta             a chave estava nao_enviada; quem chamou é o novo dono
--   repetida             a chave já existe com o mesmo digest; devolve o estado
--                        gravado e quem chamou NÃO envia nada
--   conflito_de_conteudo a chave já existe com outro digest; nada é devolvido
--                        da outra operação
--   pendencia_identica   outra chave para o mesmo lançamento está pendente
-- ---------------------------------------------------------------------------
create or replace function public.reivindicar_tentativa_conta_pagar(
    p_organizacao_id uuid,
    p_chave uuid,
    p_digest text,
    p_valor numeric,
    p_data_vencimento date,
    p_data_emissao date,
    p_contato_bling_id bigint
)
returns table (
    tentativa_id uuid,
    estado text,
    epoca integer,
    bling_conta_id text,
    titulo_id uuid,
    contato_bling_id bigint,
    desfecho text,
    chave_pendente uuid
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

    -- Inserir direto: a mesma chave cai no `on conflict`; outra chave para o
    -- mesmo lançamento pendente cai no índice parcial (23505). Nenhum dos dois
    -- é "consulta e depois decide".
    begin
        insert into public.tentativas_conta_pagar
            (organizacao_id, chave, digest, valor, data_vencimento, data_emissao, contato_bling_id)
        values
            (p_organizacao_id, p_chave, p_digest, p_valor, p_data_vencimento, p_data_emissao, p_contato_bling_id)
        on conflict on constraint uq_tentativas_conta_pagar_org_chave do nothing
        returning id into v_id;
    exception
        when unique_violation then
            select t.chave into v_chave_pendente
            from public.tentativas_conta_pagar t
            where t.organizacao_id = p_organizacao_id
              and t.digest = p_digest
              and t.estado in ('em_voo', 'indeterminada')
            limit 1;
            return query select null::uuid, null::text, null::integer, null::text, null::uuid, null::bigint,
                                'pendencia_identica'::text, v_chave_pendente;
            return;
    end;

    if v_id is not null then
        return query select v_id, 'em_voo'::text, 1, null::text, null::uuid, p_contato_bling_id,
                            'nova'::text, null::uuid;
        return;
    end if;

    -- A linha existe: o FOR UPDATE bloqueia de verdade contra outra
    -- reivindicação da mesma chave e lê o estado já commitado.
    select t.id, t.estado, t.epoca, t.digest, t.bling_conta_id, t.titulo_id, t.contato_bling_id
    into v_existente
    from public.tentativas_conta_pagar t
    where t.organizacao_id = p_organizacao_id
      and t.chave = p_chave
    for update;

    if v_existente.digest is distinct from p_digest then
        return query select null::uuid, null::text, null::integer, null::text, null::uuid, null::bigint,
                            'conflito_de_conteudo'::text, null::uuid;
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
                                    'pendencia_identica'::text, v_chave_pendente;
                return;
        end;
        return query select v_existente.id, 'em_voo'::text, v_epoca, null::text, null::uuid,
                            v_existente.contato_bling_id, 'reaberta'::text, null::uuid;
        return;
    end if;

    return query select v_existente.id, v_existente.estado, v_existente.epoca, v_existente.bling_conta_id,
                        v_existente.titulo_id, v_existente.contato_bling_id, 'repetida'::text, null::uuid;
end;
$$;

revoke all on function public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint)
    from public, anon, authenticated;
grant execute on function public.reivindicar_tentativa_conta_pagar(uuid, uuid, text, numeric, date, date, bigint)
    to service_role;
