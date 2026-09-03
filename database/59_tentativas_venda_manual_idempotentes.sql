-- 59_tentativas_venda_manual_idempotentes.sql
-- Forward-only. Ticket 30, fatia 3 — endurecida nas 3ª, 4ª e 5ª rodadas de
-- revisão. NUNCA APLICADA REMOTAMENTE: as rodadas seguintes corrigiram esta
-- migration no lugar, em vez de empilhar 60/61 sobre um schema que ainda não
-- existe em banco nenhum.
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
-- Bling — mesmo propósito de `registrar_evento_inbox_bling` (migration 28)
-- para o inbox do webhook, mas por `INSERT ... ON CONFLICT DO NOTHING`, que é
-- atômico por construção (ver o comentário dentro da função: a versão que
-- fazia `SELECT ... FOR UPDATE` antes do `INSERT` reproduzia, aqui dentro, a
-- própria corrida que o ticket 30 existe para fechar).
--
-- ---------------------------------------------------------------------------
-- A CHAVE SOZINHA NÃO BASTA (5ª rodada de revisão)
-- ---------------------------------------------------------------------------
-- Reconhecer a referência responde "já vi este UUID antes?". A pergunta que
-- uma chave de idempotência precisa responder é outra: "esta é a MESMA
-- operação que eu já vi?". Sem isso, a referência pendente de uma tentativa
-- indeterminada, reenviada depois que o usuário mudou cliente, produto ou
-- quantidade, seria tratada como retentativa — devolvendo "já registrada"
-- para uma venda que ninguém registrou, ou reabrindo a chave para criar no
-- Bling uma venda diferente da que ela identifica. Por isso a coluna
-- `fingerprint`: mesma chave + mesmo fingerprint é retentativa; mesma chave +
-- outro fingerprint é CONFLITO, e o conflito nunca executa nem devolve o
-- resultado da outra operação.
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
    -- 5ª rodada de revisão: SHA-256 da intenção comercial da venda (ver
    -- `src/lib/config/manualOrderFingerprint.ts`). Sem ele, a chave responde
    -- só "já vi este UUID antes?", e não "esta é a MESMA operação?" — e a
    -- mesma referência reenviada com outro cliente/produto/quantidade seria
    -- tratada como retentativa de uma venda que ninguém pediu.
    fingerprint       text not null,
    -- 6ª rodada: impressão digital dos VALORES resolvidos no servidor (preços
    -- unitários do cadastro + total derivado). O fingerprint acima cobre o que
    -- o cliente pediu; este cobre o que a venda vale. Sem ele, uma tentativa
    -- `falhou` reaberta depois de o preço mudar reexecutaria a venda por outro
    -- valor, sem ninguém confirmar o valor novo.
    valores_fingerprint text not null,
    estado            text not null default 'em_andamento'
                       check (estado in ('em_andamento', 'concluida', 'indeterminada', 'falhou')),
    pedido_id         uuid references public.pedidos(id) on delete set null,
    bling_pedido_id   text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint uq_tentativas_venda_manual_org_referencia unique (organizacao_id, referencia_local)
);

-- Guarda de re-execução: se esta migration já tiver criado a tabela numa
-- versão anterior (sem `fingerprint`), o `create table if not exists` acima
-- não a alteraria. O default vazio existe só para satisfazer o NOT NULL das
-- linhas antigas — e '' nunca bate um SHA-256 real, então uma tentativa
-- herdada assim FALHA FECHADO (vira conflito de fingerprint) em vez de ser
-- reaproveitada às cegas.
alter table public.tentativas_venda_manual
    add column if not exists fingerprint text not null default '';
alter table public.tentativas_venda_manual
    alter column fingerprint drop default;
alter table public.tentativas_venda_manual
    add column if not exists valores_fingerprint text not null default '';
alter table public.tentativas_venda_manual
    alter column valores_fingerprint drop default;

revoke all on public.tentativas_venda_manual from public, anon;
grant select on public.tentativas_venda_manual to authenticated;
grant all on public.tentativas_venda_manual to service_role, postgres;

create index if not exists idx_tentativas_venda_manual_org_estado
    on public.tentativas_venda_manual(organizacao_id, estado);

-- Suporta a busca por pendência idêntica (6ª rodada): "existe outra tentativa
-- sem desfecho para exatamente esta venda?".
create index if not exists idx_tentativas_venda_manual_org_fingerprint
    on public.tentativas_venda_manual(organizacao_id, fingerprint, estado);

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
-- 2. Reivindicação atômica da referência, conferindo o fingerprint: se a
--    chave já existe com o MESMO conteúdo, devolve o desfecho anterior em vez
--    de executar de novo; com conteúdo DIFERENTE, devolve conflito.
-- ---------------------------------------------------------------------------
-- A assinatura de 2 argumentos (sem fingerprint) sai de circulação: mantê-la
-- criaria uma sobrecarga que o PostgREST poderia escolher, e chamá-la seria
-- reivindicar uma referência SEM conferir se o conteúdo é o mesmo — exatamente
-- o furo que a 5ª rodada de revisão apontou.
drop function if exists public.reivindicar_tentativa_venda_manual(uuid, text);
drop function if exists public.reivindicar_tentativa_venda_manual(uuid, text, text);

create or replace function public.reivindicar_tentativa_venda_manual(
    p_organizacao_id uuid,
    p_referencia_local text,
    p_fingerprint text,
    p_valores_fingerprint text
)
returns table (
    tentativa_id uuid,
    estado text,
    pedido_id uuid,
    bling_pedido_id text,
    is_duplicate boolean,
    fingerprint_conflitante boolean,
    valores_divergentes boolean,
    -- Quando preenchida: existe OUTRA tentativa ainda sem desfecho para
    -- exatamente esta mesma venda, e é preciso resolvê-la antes de abrir uma
    -- nova. Ver o bloco `PENDENCIA IDENTICA` no corpo da função.
    referencia_pendente text
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existente record;
    v_new_id uuid;
    v_referencia_pendente text;
begin
    if p_organizacao_id is null or p_referencia_local is null or p_referencia_local = ''
       or p_fingerprint is null or p_fingerprint = ''
       or p_valores_fingerprint is null or p_valores_fingerprint = '' then
        raise exception 'Organizacao, referencia local, fingerprint e valores sao obrigatorios.' using errcode = '22023';
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
    insert into public.tentativas_venda_manual (organizacao_id, referencia_local, fingerprint, valores_fingerprint, estado)
    values (p_organizacao_id, p_referencia_local, p_fingerprint, p_valores_fingerprint, 'em_andamento')
    on conflict (organizacao_id, referencia_local) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
        -- PENDENCIA IDENTICA (6a rodada de revisao). A chave e nova, mas ja
        -- existe OUTRA tentativa sem desfecho para exatamente esta mesma
        -- venda. Nao da para saber, daqui, se isto e a mesma venda tentada de
        -- novo (o navegador perdeu a referencia — localStorage indisponivel,
        -- outro dispositivo) ou uma segunda venda legitimamente identica. As
        -- duas sao possiveis, e tratar como retentativa apagaria uma venda
        -- real, enquanto tratar como nova poderia duplicar um pedido no ERP.
        --
        -- Entao nenhuma das duas: recusa e devolve a referencia pendente, para
        -- que ela seja resolvida (reconciliada) primeiro. E o que torna a
        -- protecao independente do navegador — sem isto, um cliente sem
        -- memoria local viraria criacao externa duplicada.
        select t.referencia_local into v_referencia_pendente
        from public.tentativas_venda_manual t
        where t.organizacao_id = p_organizacao_id
          and t.fingerprint = p_fingerprint
          and t.estado in ('em_andamento', 'indeterminada')
          and t.id <> v_new_id
        order by t.created_at
        limit 1;

        if v_referencia_pendente is not null then
            -- A linha recem-inserida e nossa e ainda nao produziu efeito
            -- nenhum: remove-la deixa o ledger exatamente como estava.
            delete from public.tentativas_venda_manual where id = v_new_id;
            return query select null::uuid, null::text, null::uuid, null::text, false, false, false, v_referencia_pendente;
            return;
        end if;

        return query select v_new_id, 'em_andamento'::text, null::uuid, null::text, false, false, false, null::text;
        return;
    end if;

    -- Conflito: ja existe uma tentativa com esta referencia. A LINHA AGORA
    -- EXISTE, entao `FOR UPDATE` bloqueia de verdade contra qualquer outra
    -- reivindicacao concorrente da MESMA referencia, e le o estado ja
    -- commitado quando destrava — o mesmo padrao provado em
    -- `evidence/30-atomicidade-da-tomada-2026-09-03.md`.
    select id,
           tentativas_venda_manual.estado,
           tentativas_venda_manual.pedido_id,
           tentativas_venda_manual.bling_pedido_id,
           tentativas_venda_manual.fingerprint,
           tentativas_venda_manual.valores_fingerprint
    into v_existente
    from public.tentativas_venda_manual
    where organizacao_id = p_organizacao_id
      and referencia_local = p_referencia_local
    for update;

    -- CONFLITO DE CONTEUDO (5ª rodada de revisao). A chave ja foi usada, mas
    -- para OUTRA venda. Nao e retentativa: nao executa, nao reabre, e nao
    -- devolve o desfecho da tentativa anterior — devolver seria dizer "sua
    -- venda ja foi registrada" sobre uma venda que ninguem registrou.
    -- Nenhum id sai daqui: o resultado da outra operacao nao e desta.
    if v_existente.fingerprint is distinct from p_fingerprint then
        return query select null::uuid, null::text, null::uuid, null::text, true, true, false, null::text;
        return;
    end if;

    if v_existente.estado = 'falhou' then
        -- 6a rodada: a venda pedida e a mesma, mas os VALORES resolvidos
        -- mudaram (o preco do cadastro mudou entre as tentativas). Reabrir
        -- aqui reexecutaria por outro valor, sem ninguem ter confirmado o
        -- valor novo. Recusa, para a venda ser reconfirmada.
        if v_existente.valores_fingerprint is distinct from p_valores_fingerprint then
            return query select null::uuid, null::text, null::uuid, null::text, true, false, true, null::text;
            return;
        end if;
        -- Falha DEFINITIVA anterior, com a compensacao CONFIRMADA (a
        -- aplicacao so grava 'falhou' quando o Bling nao tem nada pendente —
        -- ver a maquina de estados em `compensacao.ts`). Seguro reabrir a
        -- MESMA referencia para uma nova tentativa.
        update public.tentativas_venda_manual
        set estado = 'em_andamento', pedido_id = null, bling_pedido_id = null
        where id = v_existente.id;
        return query select v_existente.id, 'em_andamento'::text, null::uuid, null::text, false, false, false, null::text;
        return;
    end if;

    return query select v_existente.id, v_existente.estado, v_existente.pedido_id, v_existente.bling_pedido_id, true, false, false, null::text;
    return;
end;
$$;

revoke all on function public.reivindicar_tentativa_venda_manual(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.reivindicar_tentativa_venda_manual(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Conclusão — grava o desfecho final da tentativa, para a próxima
--    reivindicação com a mesma referência encontrar um estado terminal em
--    vez de 'em_andamento' para sempre.
-- ---------------------------------------------------------------------------
-- A assinatura anterior (sem `p_organizacao_id`) sai de circulacao. Ela
-- atualizava POR ID, sem nenhum predicado de organizacao, dentro de uma
-- funcao `security definer` — que ignora RLS por construcao. Nao era
-- explorável pelo caminho atual (o id vinha da reivindicacao da propria
-- requisicao), mas era um seam multi-tenant aberto num mecanismo que decide
-- se uma escrita externa pode acontecer, e a rota de reconciliacao da 5ª
-- rodada passa a resolver tentativas a partir de dado vindo do cliente.
drop function if exists public.concluir_tentativa_venda_manual(uuid, text, uuid, text);

create or replace function public.concluir_tentativa_venda_manual(
    p_organizacao_id uuid,
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
declare
    v_afetadas integer;
begin
    if p_organizacao_id is null or p_tentativa_id is null then
        raise exception 'Organizacao e tentativa sao obrigatorias.' using errcode = '22023';
    end if;
    if p_estado not in ('concluida', 'indeterminada', 'falhou') then
        raise exception 'Estado final invalido: %', p_estado using errcode = '22023';
    end if;

    -- O predicado de organizacao e a UNICA barreira que resta aqui dentro:
    -- `security definer` ignora RLS.
    update public.tentativas_venda_manual
    set estado = p_estado,
        pedido_id = coalesce(p_pedido_id, pedido_id),
        bling_pedido_id = coalesce(p_bling_pedido_id, bling_pedido_id)
    where id = p_tentativa_id
      and organizacao_id = p_organizacao_id;

    get diagnostics v_afetadas = row_count;
    if v_afetadas = 0 then
        -- Nao existe, ou e de outra organizacao. As duas coisas sao a mesma
        -- resposta de proposito: distinguir revelaria a existencia de uma
        -- tentativa alheia.
        raise exception 'Tentativa de venda manual nao encontrada nesta organizacao.' using errcode = 'P0002';
    end if;
end;
$$;

revoke all on function public.concluir_tentativa_venda_manual(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.concluir_tentativa_venda_manual(uuid, uuid, text, uuid, text) to service_role;
