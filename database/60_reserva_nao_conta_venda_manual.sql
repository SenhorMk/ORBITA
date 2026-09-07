-- 60_reserva_nao_conta_venda_manual.sql
-- Forward-only. Ticket 30 — fatia descoberta pela jornada real no staging.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO, medido em produção de teste
-- ---------------------------------------------------------------------------
-- Venda manual de 1 unidade de "Rapé Pequeno Artemísia - 15ml":
--
--   baseline   estoque=2  reservado=0   -> disponível 2
--   depois     estoque=1  reservado=1   -> disponível 0
--
-- Uma venda de UMA unidade derrubou a disponibilidade em DUAS. O invariante do
-- ticket 30 diz o contrário: 1 unidade vendida manualmente derruba a
-- disponibilidade em exatamente 1.
--
-- ## Como as duas metades se somam
--
-- A venda manual (`registrar_venda_manual`, migration 57) grava o pedido já
-- como `Entregue` e dá baixa FÍSICA em `produtos.estoque`. `Entregue` é estado
-- final, então a migration 58 corretamente NÃO reserva nada na inserção dos
-- itens. Até aqui, disponibilidade caiu 1.
--
-- Segundos depois o `order.created` chega. `processPedidoEvent` sincroniza a
-- situação do Bling e faz `upsert` na MESMA linha, trocando o status para
-- `Pendente` — que não é final. Aí `fn_atualizar_reserva_status_pedido` vê a
-- transição `Entregue -> Pendente`, conclui "voltou a ser um pedido em aberto"
-- e RE-RESERVA a quantidade. A reserva reaparece sobre um estoque que já foi
-- baixado fisicamente, e a mesma unidade passa a ser descontada duas vezes.
--
-- A regra da 58 estava certa para pedidos do Bling, onde reserva e baixa são
-- momentos distintos do mesmo ciclo. Ela é errada para a venda manual, onde a
-- baixa já aconteceu no ato.
--
-- ---------------------------------------------------------------------------
-- A CORREÇÃO
-- ---------------------------------------------------------------------------
-- Um pedido de origem `Loja Física / Manual` NUNCA contribui para
-- `estoque_reservado`. Não é uma máquina de estados nova: é o discriminador
-- que já existe na linha (`pedidos.origem`) sendo consultado pelos dois
-- gatilhos que mexem em reserva.
--
-- ## Por que a regra é um PREDICADO, e não uma guarda em cada ramo
--
-- A primeira versão desta migration guardava só o ramo de re-reserva e
-- deixava a LIBERAÇÃO incondicional. A revisão independente achou o buraco
-- que isso abre, e ele é real:
--
--   1. venda manual `Entregue`, reservado = 0;
--   2. webhook traz `Pendente` — corretamente não reserva, continua 0;
--   3. webhook posterior traz `Entregue` (ou `Cancelado`);
--   4. o ramo de liberação subtrai uma quantidade que essa venda manual
--      NUNCA reservou.
--
-- O resultado é uma reserva negativa — ou, com `chk_produto_reservado` no
-- lugar, o webhook estourando de novo. E como `estoque_reservado` é um
-- agregado por PRODUTO, o erro não fica contido: ele corrompe a
-- disponibilidade de todos os outros pedidos daquele produto. É exatamente
-- por isso que `greatest(estoque_reservado - quantidade, 0)` seria a correção
-- errada — aparar em zero esconde a subtração indevida em vez de não fazê-la.
--
-- A regra certa não é "quando liberar" nem "quando reservar", e sim **quem
-- contribui para a reserva**:
--
--     contribui := status não é final  E  origem não é venda manual
--
-- Com o predicado, os dois ramos ficam simétricos e se derivam dele: libera
-- quando deixou de contribuir, reserva quando passou a contribuir. Cada
-- transição é decidida comparando o estado ANTIGO com o NOVO, o que é
-- justamente o que faltava.
--
-- O caso que exige cuidado, e que o predicado preserva: quando o webhook cria
-- a linha primeiro (`Bling`/`Pendente`, contribuindo) e a venda manual a
-- assume (migration 57, virando `Loja Física / Manual`/`Entregue`), o antigo
-- contribuía e o novo não — então libera, e a reserva do webhook não fica
-- presa como fantasma.
--
-- Em uma frase: reserva de venda manual não nasce, e só morre a reserva que
-- de fato nasceu.
--
-- O gatilho passa a observar `origem` além de `status` porque o predicado
-- depende das duas colunas. Um predicado que depende de uma coluna que o
-- gatilho não observa é meia garantia — a família de defeito que este ticket
-- vem encontrando.
--
-- REINTRODUZIR O DEFEITO: volte o ramo de liberação para
-- `if (v_new_finalizado and not v_old_finalizado)`. O pgTAP
-- `reserva_venda_manual.test.sql` falha nas asserções da volta da venda
-- manual a um estado final.
-- ---------------------------------------------------------------------------

/**
 * A origem que marca uma venda já baixada fisicamente no ato.
 *
 * Repetida como literal nos dois gatilhos abaixo, e não extraída para uma
 * função, porque é exatamente o mesmo literal que `registrar_venda_manual`
 * (migration 57) grava e compara. Um ponto só de verdade que já existe.
 */

create or replace function fn_atualizar_estoque_reservado()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    v_pedido_finalizado boolean;
    v_origem text;
begin
    if (tg_op = 'DELETE') then
        select (status in ('Cancelado', 'Entregue')), origem
          into v_pedido_finalizado, v_origem
          from pedidos where id = old.pedido_id;
    else
        select (status in ('Cancelado', 'Entregue')), origem
          into v_pedido_finalizado, v_origem
          from pedidos where id = new.pedido_id;
    end if;

    -- Venda manual não reserva NUNCA: o estoque dela já saiu fisicamente em
    -- `registrar_venda_manual`. Sem esta guarda, o webhook que reabre o status
    -- e regrava os itens faria a mesma unidade contar duas vezes.
    if (v_pedido_finalizado = true or v_origem = 'Loja Física / Manual') then
        if (tg_op = 'DELETE') then return old; else return new; end if;
    end if;

    if (tg_op = 'INSERT') then
        update produtos set estoque_reservado = estoque_reservado + new.quantidade where id = new.produto_id;
        return new;
    elsif (tg_op = 'DELETE') then
        update produtos set estoque_reservado = estoque_reservado - old.quantidade where id = old.produto_id;
        return old;
    elsif (tg_op = 'UPDATE') then
        if (old.produto_id = new.produto_id) then
            update produtos set estoque_reservado = estoque_reservado + (new.quantidade - old.quantidade) where id = new.produto_id;
        else
            update produtos set estoque_reservado = estoque_reservado - old.quantidade where id = old.produto_id;
            update produtos set estoque_reservado = estoque_reservado + new.quantidade where id = new.produto_id;
        end if;
        return new;
    end if;
    return null;
end;
$$;

create or replace function fn_atualizar_reserva_status_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    -- QUEM CONTRIBUI PARA A RESERVA: pedido ainda em aberto no ERP e que não
    -- seja venda manual (essa já saiu do estoque fisicamente). Os dois ramos
    -- abaixo são consequências deste predicado, não regras independentes.
    v_old_contribuia boolean := old.status not in ('Cancelado', 'Entregue')
                                and old.origem is distinct from 'Loja Física / Manual';
    v_new_contribui  boolean := new.status not in ('Cancelado', 'Entregue')
                                and new.origem is distinct from 'Loja Física / Manual';
begin
    -- Deixou de contribuir: devolve o que ESTE pedido tinha reservado. É por
    -- aqui que a linha criada pelo webhook (`Bling`/`Pendente`) devolve a
    -- reserva quando a venda manual a assume.
    if (v_old_contribuia and not v_new_contribui) then
        update produtos p set estoque_reservado = p.estoque_reservado - coalesce(i.quantidade, 0)
        from itens_pedido i where i.pedido_id = new.id and i.produto_id = p.id;

    -- Passou a contribuir: reserva. Uma venda manual nunca entra aqui, e uma
    -- venda manual que o Bling reporta como não-final continua não entrando.
    elsif (not v_old_contribuia and v_new_contribui) then
        update produtos p set estoque_reservado = p.estoque_reservado + coalesce(i.quantidade, 0)
        from itens_pedido i where i.pedido_id = new.id and i.produto_id = p.id;
    end if;
    return new;
end;
$$;

-- O predicado lê `origem`, então o gatilho precisa acordar quando ela muda —
-- não só quando o `status` muda. Sem isto, uma linha que virasse venda manual
-- sem mudar de status manteria a reserva do webhook presa.
drop trigger if exists tg_pedidos_reserva_status on pedidos;
create trigger tg_pedidos_reserva_status
after update of status, origem on pedidos
for each row execute function fn_atualizar_reserva_status_pedido();
