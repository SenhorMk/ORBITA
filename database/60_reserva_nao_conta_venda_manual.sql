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
-- O que **não** muda, e é o caso que exige cuidado: a LIBERAÇÃO continua
-- incondicional. Quando o webhook cria a linha primeiro (`Bling`/`Pendente`,
-- reservando) e a venda manual depois assume aquela linha (migration 57,
-- virando `Loja Física / Manual`/`Entregue`), a transição não-final -> final
-- precisa devolver a reserva que o webhook criou. Guardar essa metade pela
-- origem NOVA deixaria uma reserva fantasma presa para sempre.
--
-- Em uma frase: reserva de venda manual não nasce; reserva que já nasceu
-- morre normalmente.
--
-- REINTRODUZIR O DEFEITO: remova a cláusula `and new.origem is distinct from
-- 'Loja Física / Manual'` do ramo de re-reserva. O pgTAP
-- `reserva_venda_manual.test.sql` falha na asserção da ordem
-- "venda manual -> webhook".
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
    v_old_finalizado boolean := old.status in ('Cancelado', 'Entregue');
    v_new_finalizado boolean := new.status in ('Cancelado', 'Entregue');
begin
    -- LIBERAÇÃO: incondicional, de propósito. É por aqui que a linha criada
    -- pelo webhook (`Bling`/`Pendente`, já reservada) devolve a reserva quando
    -- a venda manual assume a linha e a conclui. Guardar esta metade pela
    -- origem nova prenderia a reserva do webhook para sempre.
    if (v_new_finalizado and not v_old_finalizado) then
        update produtos p set estoque_reservado = p.estoque_reservado - coalesce(i.quantidade, 0)
        from itens_pedido i where i.pedido_id = new.id and i.produto_id = p.id;

    -- RE-RESERVA: só para pedido que de fato voltou a ficar em aberto no ERP.
    -- Uma venda manual que o Bling reporta como não-final continua sendo uma
    -- venda cujo estoque já saiu; reservá-la de novo é contar duas vezes.
    elsif (not v_new_finalizado and v_old_finalizado
           and new.origem is distinct from 'Loja Física / Manual') then
        update produtos p set estoque_reservado = p.estoque_reservado + coalesce(i.quantidade, 0)
        from itens_pedido i where i.pedido_id = new.id and i.produto_id = p.id;
    end if;
    return new;
end;
$$;
