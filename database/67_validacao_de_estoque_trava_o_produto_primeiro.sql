-- 67_validacao_de_estoque_trava_o_produto_primeiro.sql
-- Forward-only. Corrige a atomicidade da validação introduzida na 66.
--
-- ---------------------------------------------------------------------------
-- INVARIANTE
-- ---------------------------------------------------------------------------
-- A demanda vigente da linha e a disponibilidade do produto precisam ser lidas
-- sob o MESMO ponto de serialização. O produto é esse ponto, e é travado antes
-- de qualquer uma das duas leituras.
--
-- A regra de cobrança não muda:
--
--     delta = nova quantidade - quantidade já demandada por esta linha
--     delta <= 0  -> nada é consumido
--     delta >  0  -> exige estoque - (reservado + delta) >= 0
--
-- ---------------------------------------------------------------------------
-- A CORRIDA QUE A ORDEM ERRADA PERMITIA
-- ---------------------------------------------------------------------------
-- Com a leitura da linha ANTES do travamento do produto, duas transações
-- aplicando o mesmo item se cruzavam assim:
--
--   T1  insere a linha; reserva +1; mantém o produto travado até o commit.
--   T2  lê `itens_pedido` e não vê a linha de T1, que é não-commitada:
--       conclui demanda vigente 0 e delta 1; então bloqueia no produto.
--   T1  commita.
--   T2  destrava, relê o produto — agora com a reserva de T1 — e compara a
--       reserva NOVA contra uma demanda vigente VELHA: recusa com
--       `check_violation`.
--
-- A recusa é falsa: o efeito real de T2 seria o conflito resolvido em
-- `do update` com a mesma quantidade, ou seja, delta zero e consumo nenhum.
-- Os dois fatos vinham de instantes diferentes.
--
-- Travar o produto primeiro alinha os dois: quando T2 obtém o travamento, T1 já
-- commitou, e a leitura seguinte da linha — statement novo, snapshot novo —
-- enxerga a linha dela. Demanda vigente 1, delta 0, aceito sem consumir.
--
-- Como efeito colateral, a ordem de travamento passa a ser uniforme em todos os
-- caminhos que mexem em estoque: primeiro `produtos`, depois `itens_pedido`.
--
-- REINTRODUZIR O DEFEITO: volte a leitura de `produtos` para depois do cálculo
-- do delta, como estava na 66. A encenação
-- `scripts/database-concurrency-item-replay.mjs` recusa T2 com 23514.
-- ---------------------------------------------------------------------------

create or replace function fn_validar_estoque_disponivel()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    v_estoque         integer;
    v_reservado       integer;
    v_demanda_vigente integer;
    v_delta           integer;
begin
    -- O ponto de serialização, travado antes de qualquer leitura de demanda.
    select estoque, estoque_reservado
      into v_estoque, v_reservado
      from produtos
     where id = new.produto_id
       for update;

    if not found then
        raise exception 'Produto com ID % não encontrado.', new.produto_id;
    end if;

    -- Quanto esta linha já demanda hoje, lido já sob o travamento acima.
    if tg_op = 'UPDATE' and old.produto_id = new.produto_id then
        v_demanda_vigente := old.quantidade;
    else
        -- Ramo de insert (e de troca de produto): num
        -- `insert ... on conflict do update` o BEFORE INSERT roda antes da
        -- resolução do conflito, então a linha pode já existir.
        select quantidade
          into v_demanda_vigente
          from itens_pedido
         where pedido_id = new.pedido_id
           and produto_id = new.produto_id
           for update;

        if not found then
            v_demanda_vigente := 0;
        end if;
    end if;

    v_delta := new.quantidade - v_demanda_vigente;

    -- Reaplicar o mesmo estado, ou reduzir, não consome disponibilidade.
    if v_delta <= 0 then
        return new;
    end if;

    if v_estoque - (v_reservado + v_delta) < 0 then
        raise exception 'Estoque insuficiente para o produto "%".', new.produto_id
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;
