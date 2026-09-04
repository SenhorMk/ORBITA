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

-- ---------------------------------------------------------------------------
-- EXCLUSAO MUTUA DE PENDENCIA (7ª rodada de revisão) — a invariância central
-- desta migration, e agora imposta pelo BANCO, não por leitura-e-decisão.
--
-- "Numa organização, enquanto existir uma tentativa `em_andamento` ou
--  `indeterminada` para o fingerprint X, no máximo UMA referência pode
--  existir para X."
--
-- Por que um índice único PARCIAL, e não a consulta que havia antes: a versão
-- da 6ª rodada inseria a referência nova e SÓ DEPOIS procurava outra pendência
-- com o mesmo fingerprint, apagando a recém-inserida se achasse. Isso protege
-- contra a MESMA referência (o índice de `(organizacao_id, referencia_local)`
-- faz isso), e NÃO protege contra referências DIFERENTES: em `READ COMMITTED`,
-- A insere `RA/X` e B insere `RB/X`, e o `SELECT` de cada uma não enxerga a
-- linha ainda não commitada da outra. As duas passavam, e as duas chegariam ao
-- Bling. **Reproduzido contra PostgreSQL real com duas conexões** — ver
-- `scripts/database-concurrency-pendencia.mjs`, modo `dois-vencedores`.
--
-- Com o índice parcial, a segunda inserção BLOQUEIA no índice até a primeira
-- transação decidir, e então falha com `23505` — que a função trata,
-- devolvendo a referência pendente. O predicado `where estado in (...)` é o
-- que permite que uma segunda venda legitimamente idêntica volte a existir
-- assim que a pendência anterior for resolvida: `concluida`/`falhou` saem do
-- índice.
-- ---------------------------------------------------------------------------
create unique index if not exists uq_tentativas_venda_manual_pendencia_por_fingerprint
    on public.tentativas_venda_manual(organizacao_id, fingerprint)
    where estado in ('em_andamento', 'indeterminada');

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
    -- ATOMICO POR CONSTRUCAO, em DUAS dimensoes:
    --
    --   1. `on conflict (organizacao_id, referencia_local)` — a MESMA
    --      referencia reenviada nao insere linha nova;
    --   2. o indice unico PARCIAL de pendencia — duas referencias DIFERENTES
    --      para a MESMA venda nao podem coexistir sem desfecho. A segunda
    --      bloqueia no indice ate a primeira decidir, e entao levanta `23505`,
    --      tratado logo abaixo.
    --
    -- Nenhuma das duas e "consulta e depois decide": as duas sao o proprio
    -- banco recusando, que e a unica forma de valer sob concorrencia real.
    begin
        insert into public.tentativas_venda_manual (organizacao_id, referencia_local, fingerprint, valores_fingerprint, estado)
        values (p_organizacao_id, p_referencia_local, p_fingerprint, p_valores_fingerprint, 'em_andamento')
        on conflict (organizacao_id, referencia_local) do nothing
        returning id into v_new_id;
    exception
        when unique_violation then
            -- So pode ser o indice parcial de pendencia: o conflito da
            -- referencia e absorvido pelo `on conflict` acima. Ja existe
            -- outra tentativa sem desfecho para exatamente esta venda.
            --
            -- Nao da para saber, daqui, se isto e a mesma venda tentada de
            -- novo (o navegador perdeu a referencia, ou e outro dispositivo)
            -- ou uma segunda venda legitimamente identica. As duas sao
            -- possiveis: tratar como retentativa apagaria uma venda real,
            -- tratar como nova poderia duplicar um pedido no ERP. Entao
            -- nenhuma das duas — recusa e aponta a pendencia, para ser
            -- resolvida primeiro.
            select t.referencia_local into v_referencia_pendente
            from public.tentativas_venda_manual t
            where t.organizacao_id = p_organizacao_id
              and t.fingerprint = p_fingerprint
              and t.estado in ('em_andamento', 'indeterminada')
            limit 1;

            return query select null::uuid, null::text, null::uuid, null::text, false, false, false, v_referencia_pendente;
            return;
    end;

    if v_new_id is not null then
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
        -- Reabrir e voltar a ocupar o indice parcial de pendencia. Se outra
        -- tentativa sem desfecho ja ocupa este fingerprint, a reabertura tem
        -- de ser recusada pelo mesmo motivo de sempre.
        begin
            update public.tentativas_venda_manual
            set estado = 'em_andamento', pedido_id = null, bling_pedido_id = null
            where id = v_existente.id;
        exception
            when unique_violation then
                select t.referencia_local into v_referencia_pendente
                from public.tentativas_venda_manual t
                where t.organizacao_id = p_organizacao_id
                  and t.fingerprint = p_fingerprint
                  and t.estado in ('em_andamento', 'indeterminada')
                limit 1;
                return query select null::uuid, null::text, null::uuid, null::text, false, false, false, v_referencia_pendente;
                return;
        end;
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
-- A assinatura de 5 argumentos (sem CAS) tambem sai: com o parametro novo
-- tendo default, mante-la deixaria uma chamada de 5 argumentos ambigua entre
-- as duas.
drop function if exists public.concluir_tentativa_venda_manual(uuid, uuid, text, uuid, text);

create or replace function public.concluir_tentativa_venda_manual(
    p_organizacao_id uuid,
    p_tentativa_id uuid,
    p_estado text,
    p_pedido_id uuid default null,
    p_bling_pedido_id text default null,
    -- 7ª rodada: compare-and-set. Quando informado, a escrita so acontece se
    -- o estado atual for exatamente este.
    --
    -- Quem PRODUZIU o efeito (o handler da venda) escreve incondicionalmente:
    -- ele sabe o que aconteceu. Quem chega DEPOIS e opina sobre uma tentativa
    -- alheia (a reconciliacao) precisa provar que o mundo nao mudou entre ler
    -- e decidir — idade nao e sincronizacao, e sem CAS a reconciliacao podia
    -- sobrescrever o desfecho de uma requisicao que ainda estava em voo.
    p_estado_esperado text default null
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
      and organizacao_id = p_organizacao_id
      and (p_estado_esperado is null or estado = p_estado_esperado);

    get diagnostics v_afetadas = row_count;
    if v_afetadas = 0 then
        if p_estado_esperado is not null then
            -- CAS perdeu: alguem mudou o estado entre a leitura e esta
            -- escrita. Quem chamou tem de reler e decidir de novo, nunca
            -- insistir por cima.
            raise exception 'Estado da tentativa mudou desde a leitura (esperado %).', p_estado_esperado
                using errcode = '40001';
        end if;
        -- Nao existe, ou e de outra organizacao. As duas coisas sao a mesma
        -- resposta de proposito: distinguir revelaria a existencia de uma
        -- tentativa alheia.
        raise exception 'Tentativa de venda manual nao encontrada nesta organizacao.' using errcode = 'P0002';
    end if;
end;
$$;

revoke all on function public.concluir_tentativa_venda_manual(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.concluir_tentativa_venda_manual(uuid, uuid, text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Intervenções operacionais sobre uma tentativa (7ª rodada de revisão).
--
-- Duas necessidades que se resolvem com a MESMA estrutura:
--
--   **Auditoria.** "O estado da tentativa mudou" não é rastro: não diz quem
--   pediu, o que foi pedido, sobre qual pedido do Bling, quando, nem no que
--   deu. `updated_at` guarda o instante da última escrita e nada mais — e é
--   sobrescrito pela escrita seguinte. Uma intervenção que dispara efeito
--   externo no ERP precisa de registro próprio e imutável.
--
--   **Concorrência.** Duas requisições simultâneas de `cancelar-no-bling`
--   sobre a mesma tentativa não podem produzir duas intervenções externas não
--   coordenadas. O índice parcial abaixo é o claim: a primeira insere, a
--   segunda bate no índice e é recusada. NÃO se apoia em "cancelar duas vezes
--   no Bling é inócuo" — o contrato da v3 não afirma isso em lugar nenhum.
-- ---------------------------------------------------------------------------
create table if not exists public.intervencoes_venda_manual (
    id                uuid primary key default gen_random_uuid(),
    organizacao_id    uuid not null references public.organizacoes(id) on delete cascade,
    tentativa_id      uuid not null references public.tentativas_venda_manual(id) on delete cascade,
    -- Repetida aqui de propósito: a tentativa pode ser removida (cascade da
    -- organização) e o rastro não deve virar um id órfão sem significado.
    referencia_local  text not null,
    acao              text not null check (acao in ('cancelar-no-bling')),
    -- O pedido no ERP sobre o qual a intervenção age. Nunca o payload da
    -- venda: rastro de intervenção não é lugar de dado comercial.
    bling_pedido_id   text,
    -- Ator do escopo VERIFICADO da requisição — nunca vindo do corpo.
    ator_id           uuid not null,
    solicitada_em     timestamptz not null default now(),
    concluida_em      timestamptz,
    resultado         text check (resultado in ('confirmada', 'falhou', 'ambigua')),
    -- Motivo legível quando o provedor recusa: mensagem do Bling, não
    -- diagnóstico interno nem segredo.
    detalhe           text,
    created_at        timestamptz not null default now()
);

-- O CLAIM: no máximo UMA intervenção em voo por tentativa. Uma segunda
-- requisição simultânea bate aqui e é recusada antes de tocar o ERP.
create unique index if not exists uq_intervencao_em_voo_por_tentativa
    on public.intervencoes_venda_manual(tentativa_id)
    where resultado is null;

create index if not exists idx_intervencoes_venda_manual_org
    on public.intervencoes_venda_manual(organizacao_id, solicitada_em desc);

revoke all on public.intervencoes_venda_manual from public, anon;
grant select on public.intervencoes_venda_manual to authenticated;
grant all on public.intervencoes_venda_manual to service_role, postgres;

alter table public.intervencoes_venda_manual enable row level security;

drop policy if exists "Acesso a intervencoes_venda_manual por organizacao" on public.intervencoes_venda_manual;
create policy "Acesso a intervencoes_venda_manual por organizacao"
    on public.intervencoes_venda_manual
    for select
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id));

-- IMUTABILIDADE. O registro só pode ser fechado (resultado/detalhe/conclusão);
-- nada do que ele afirma sobre a solicitação pode ser reescrito, e nenhuma
-- linha pode ser apagada. Sem isto, "auditável" seria só uma palavra.
create or replace function public.fn_intervencao_venda_manual_imutavel()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'Registro de intervencao e imutavel: remocao proibida.' using errcode = '42501';
    end if;

    if new.id is distinct from old.id
       or new.organizacao_id is distinct from old.organizacao_id
       or new.tentativa_id is distinct from old.tentativa_id
       or new.referencia_local is distinct from old.referencia_local
       or new.acao is distinct from old.acao
       or new.ator_id is distinct from old.ator_id
       or new.solicitada_em is distinct from old.solicitada_em
       or new.created_at is distinct from old.created_at then
        raise exception 'Registro de intervencao e imutavel: so o desfecho pode ser gravado.' using errcode = '42501';
    end if;

    if old.resultado is not null then
        raise exception 'Intervencao ja encerrada: desfecho nao pode ser reescrito.' using errcode = '42501';
    end if;

    return new;
end;
$$;

drop trigger if exists tg_intervencao_venda_manual_imutavel on public.intervencoes_venda_manual;
create trigger tg_intervencao_venda_manual_imutavel
    before update or delete on public.intervencoes_venda_manual
    for each row execute function public.fn_intervencao_venda_manual_imutavel();

-- ---------------------------------------------------------------------------
-- 5. Reivindicar a intervenção (o claim) e encerrá-la.
-- ---------------------------------------------------------------------------
create or replace function public.reivindicar_intervencao_venda_manual(
    p_organizacao_id uuid,
    p_tentativa_id uuid,
    p_acao text,
    p_ator_id uuid,
    p_bling_pedido_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_referencia text;
    v_id uuid;
begin
    if p_organizacao_id is null or p_tentativa_id is null or p_ator_id is null then
        raise exception 'Organizacao, tentativa e ator sao obrigatorios.' using errcode = '22023';
    end if;

    -- A tentativa tem de ser DESTA organizacao: `security definer` ignora RLS,
    -- entao o predicado aqui e a unica barreira.
    select t.referencia_local into v_referencia
    from public.tentativas_venda_manual t
    where t.id = p_tentativa_id and t.organizacao_id = p_organizacao_id;

    if v_referencia is null then
        raise exception 'Tentativa de venda manual nao encontrada nesta organizacao.' using errcode = 'P0002';
    end if;

    begin
        insert into public.intervencoes_venda_manual
            (organizacao_id, tentativa_id, referencia_local, acao, ator_id, bling_pedido_id)
        values (p_organizacao_id, p_tentativa_id, v_referencia, p_acao, p_ator_id, p_bling_pedido_id)
        returning id into v_id;
    exception
        when unique_violation then
            -- Ja existe uma intervencao EM VOO para esta tentativa. Recusa sem
            -- tocar o ERP: duas intervencoes externas nao coordenadas sobre o
            -- mesmo pedido e exatamente o que o claim existe para impedir.
            raise exception 'Ja existe uma intervencao em andamento para esta tentativa.' using errcode = '55006';
    end;

    return v_id;
end;
$$;

revoke all on function public.reivindicar_intervencao_venda_manual(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.reivindicar_intervencao_venda_manual(uuid, uuid, text, uuid, text) to service_role;

create or replace function public.encerrar_intervencao_venda_manual(
    p_organizacao_id uuid,
    p_intervencao_id uuid,
    p_resultado text,
    p_detalhe text default null,
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
    if p_resultado not in ('confirmada', 'falhou', 'ambigua') then
        raise exception 'Resultado de intervencao invalido: %', p_resultado using errcode = '22023';
    end if;

    update public.intervencoes_venda_manual
    set resultado = p_resultado,
        detalhe = p_detalhe,
        bling_pedido_id = coalesce(p_bling_pedido_id, bling_pedido_id),
        concluida_em = now()
    where id = p_intervencao_id
      and organizacao_id = p_organizacao_id
      and resultado is null;

    get diagnostics v_afetadas = row_count;
    if v_afetadas = 0 then
        raise exception 'Intervencao nao encontrada nesta organizacao, ou ja encerrada.' using errcode = 'P0002';
    end if;
end;
$$;

revoke all on function public.encerrar_intervencao_venda_manual(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.encerrar_intervencao_venda_manual(uuid, uuid, text, text, text) to service_role;
