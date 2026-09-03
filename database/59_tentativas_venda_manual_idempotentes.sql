-- 59_tentativas_venda_manual_idempotentes.sql
-- Forward-only. Ticket 30, fatia 3 — endurecida na 3ª rodada de revisão.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO QUE ESTA MIGRATION FECHA
-- ---------------------------------------------------------------------------
-- A fatia 3 ensinou o handler a NÃO compensar (cancelar no Bling) quando o
-- resultado de `persistVenda` é ambíguo e a janela de confirmação não acha a
-- venda. Isso evita a metade destrutiva do problema. Mas a revisão apontou
-- a outra metade, que ficava só numa MENSAGEM de texto ("não tente de
-- novo"): nada no SISTEMA impedia uma retentativa — humana, de proxy, de
-- browser, de qualquer camada — de repetir a criação no Bling. Sem uma
-- forma de reconhecer "isto é a MESMA tentativa de antes", cada retentativa
-- geraria um `numeroLoja` novo e criaria um SEGUNDO pedido real na conta do
-- lojista — trocando "compensação destrutiva" por "duplicação externa".
--
-- ---------------------------------------------------------------------------
-- A CORREÇÃO
-- ---------------------------------------------------------------------------
-- `pedidos.bling_id` só existe DEPOIS que o Bling responde — por isso não dá
-- para reconhecer uma tentativa repetida olhando `pedidos`. O que muda de uma
-- tentativa para a repetição da MESMA tentativa é a referência local
-- (`ORBITA-<uuid>`, hoje gerada uma vez por requisição no servidor); esta
-- migration a antecipa para uma reserva ATÔMICA, ANTES de qualquer chamada ao
-- Bling — o mesmo padrão já usado por `registrar_evento_inbox_bling`
-- (migration 28) para o inbox do webhook: `SELECT ... FOR UPDATE`, e se a
-- chave já existe, devolve o desfecho anterior em vez de inserir de novo.
--
-- O cliente (`ManualOrderModal`) passa a poder enviar essa referência; uma
-- retentativa da MESMA submissão reenvia a MESMA referência. Sem cliente
-- novo o suficiente para enviá-la, o servidor continua gerando uma nova a
-- cada chamada — mesmo comportamento de hoje, sem proteção, mas também sem
-- regressão.
--
-- ---------------------------------------------------------------------------
-- 1. A tabela.
-- ---------------------------------------------------------------------------
create table if not exists public.tentativas_venda_manual (
    id                uuid primary key default gen_random_uuid(),
    organizacao_id    uuid not null references public.organizacoes(id) on delete cascade,
    referencia_local  text not null,
    estado            text not null default 'em_andamento'
                       check (estado in ('em_andamento', 'concluida', 'indeterminada', 'falhou')),
    pedido_id         uuid references public.pedidos(id) on delete set null,
    bling_pedido_id   text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint uq_tentativas_venda_manual_org_referencia unique (organizacao_id, referencia_local)
);

revoke all on public.tentativas_venda_manual from public, anon;
grant select on public.tentativas_venda_manual to authenticated;
grant all on public.tentativas_venda_manual to service_role, postgres;

create index if not exists idx_tentativas_venda_manual_org_estado
    on public.tentativas_venda_manual(organizacao_id, estado);

alter table public.tentativas_venda_manual enable row level security;

drop policy if exists "Acesso a tentativas_venda_manual por organizacao" on public.tentativas_venda_manual;
create policy "Acesso a tentativas_venda_manual por organizacao"
    on public.tentativas_venda_manual
    for all
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));

drop trigger if exists tg_tentativas_venda_manual_updated_at on public.tentativas_venda_manual;
create trigger tg_tentativas_venda_manual_updated_at
    before update on public.tentativas_venda_manual
    for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Reivindicação atômica — o mesmo padrão de `registrar_evento_inbox_bling`
--    (migration 28): `SELECT ... FOR UPDATE`, e se a chave já existe, devolve
--    o desfecho anterior em vez de inserir uma segunda linha.
-- ---------------------------------------------------------------------------
create or replace function public.reivindicar_tentativa_venda_manual(
    p_organizacao_id uuid,
    p_referencia_local text
)
returns table (
    tentativa_id uuid,
    estado text,
    pedido_id uuid,
    bling_pedido_id text,
    is_duplicate boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existente record;
    v_new_id uuid;
begin
    if p_organizacao_id is null or p_referencia_local is null or p_referencia_local = '' then
        raise exception 'Organizacao e referencia local sao obrigatorias.' using errcode = '22023';
    end if;

    -- ATOMICO POR CONSTRUCAO: tenta inserir DIRETO, mesmo mecanismo do
    -- `INSERT ... ON CONFLICT` de `registrar_venda_manual` (migration 57).
    --
    -- A versao anterior desta funcao fazia `SELECT ... FOR UPDATE` e SO
    -- DEPOIS `INSERT` se nao achasse nada — e reproduzia, dentro do proprio
    -- mecanismo criado para fechar a corrida do ticket 30, a MESMA corrida:
    -- `SELECT ... FOR UPDATE` sobre uma linha que ainda NAO EXISTE nao
    -- bloqueia nada (nao ha o que bloquear). Duas reivindicacoes concorrentes
    -- da mesma referencia podiam as duas passar pelo `if not found` e as duas
    -- tentarem `INSERT` — a segunda batendo num `23505` NAO TRATADO, em vez
    -- de devolver `TentativaEmAndamento` graciosamente. Reproduzido contra
    -- Postgres real com duas conexoes antes desta correcao: uma vencia, a
    -- outra lancava `duplicate key value violates unique constraint
    -- "uq_tentativas_venda_manual_org_referencia"` sem nenhum tratamento.
    insert into public.tentativas_venda_manual (organizacao_id, referencia_local, estado)
    values (p_organizacao_id, p_referencia_local, 'em_andamento')
    on conflict (organizacao_id, referencia_local) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
        return query select v_new_id, 'em_andamento'::text, null::uuid, null::text, false;
        return;
    end if;

    -- Conflito: ja existe uma tentativa com esta referencia. A LINHA AGORA
    -- EXISTE, entao `FOR UPDATE` bloqueia de verdade contra qualquer outra
    -- reivindicacao concorrente da MESMA referencia, e le o estado ja
    -- commitado quando destrava — o mesmo padrao provado em
    -- `evidence/30-atomicidade-da-tomada-2026-09-03.md`.
    select id, tentativas_venda_manual.estado, tentativas_venda_manual.pedido_id, tentativas_venda_manual.bling_pedido_id
    into v_existente
    from public.tentativas_venda_manual
    where organizacao_id = p_organizacao_id
      and referencia_local = p_referencia_local
    for update;

    if v_existente.estado = 'falhou' then
        -- Falha DEFINITIVA anterior, com a compensacao CONFIRMADA (a
        -- aplicacao so grava 'falhou' quando o Bling nao tem nada pendente —
        -- ver a maquina de estados em `compensacao.ts`). Seguro reabrir a
        -- MESMA referencia para uma nova tentativa.
        update public.tentativas_venda_manual
        set estado = 'em_andamento', pedido_id = null, bling_pedido_id = null
        where id = v_existente.id;
        return query select v_existente.id, 'em_andamento'::text, null::uuid, null::text, false;
        return;
    end if;

    return query select v_existente.id, v_existente.estado, v_existente.pedido_id, v_existente.bling_pedido_id, true;
    return;
end;
$$;

revoke all on function public.reivindicar_tentativa_venda_manual(uuid, text) from public, anon, authenticated;
grant execute on function public.reivindicar_tentativa_venda_manual(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Conclusão — grava o desfecho final da tentativa, para a próxima
--    reivindicação com a mesma referência encontrar um estado terminal em
--    vez de 'em_andamento' para sempre.
-- ---------------------------------------------------------------------------
create or replace function public.concluir_tentativa_venda_manual(
    p_tentativa_id uuid,
    p_estado text,
    p_pedido_id uuid default null,
    p_bling_pedido_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_estado not in ('concluida', 'indeterminada', 'falhou') then
        raise exception 'Estado final invalido: %', p_estado using errcode = '22023';
    end if;

    update public.tentativas_venda_manual
    set estado = p_estado,
        pedido_id = coalesce(p_pedido_id, pedido_id),
        bling_pedido_id = coalesce(p_bling_pedido_id, bling_pedido_id)
    where id = p_tentativa_id;
end;
$$;

revoke all on function public.concluir_tentativa_venda_manual(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.concluir_tentativa_venda_manual(uuid, text, uuid, text) to service_role;
