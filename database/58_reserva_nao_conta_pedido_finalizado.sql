-- 58_reserva_nao_conta_pedido_finalizado.sql
-- Forward-only. Ticket 30, fatia 2 — dupla contagem de estoque.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO
-- ---------------------------------------------------------------------------
-- Toda venda manual derrubava a disponibilidade (`estoque - estoque_reservado`)
-- em DUAS unidades por unidade vendida, nao uma.
--
-- `registrar_venda_manual` insere em `itens_pedido`. Isso dispara
-- `tg_atualizar_estoque_reservado`, que soma a quantidade a
-- `estoque_reservado` — correto para um pedido PENDENTE, cujo destino ainda
-- nao se sabe. Mas a mesma funcao TAMBEM chama `baixar_estoque_organizacao`,
-- que subtrai a mesma quantidade de `estoque` — o pedido de uma venda manual
-- nasce `Entregue`, ja fisicamente baixado.
--
-- Reserva (+1) e baixa fisica (-1) juntas tiram DOIS de disponivel por UMA
-- unidade vendida. A reserva nunca era liberada depois, porque
-- `fn_atualizar_reserva_status_pedido` so libera na transicao PARA
-- `Cancelado` — um pedido que nasce `Entregue` nunca faz essa transicao.
--
-- Achado ao medir o ticket 30, e nao e a corrida: acontece com ou sem webhook
-- por perto. Mas a "tomada" do ticket 30 o torna visivel de um jeito novo: ao
-- assumir a linha que o webhook criou (que reservou 1 unidade enquanto o
-- pedido ainda era `Pendente`), a venda manual muda o status para `Entregue`
-- sem nunca liberar aquela reserva antiga — o mesmo sintoma, origem diferente.
--
-- ---------------------------------------------------------------------------
-- A CORRECAO
-- ---------------------------------------------------------------------------
-- `estoque_reservado` passa a significar exatamente "comprometido, ainda por
-- resolver" — nunca por um pedido em estado FINAL. `Cancelado` ja era um
-- estado final tratado assim; `Entregue` passa a ser o outro.
--
-- Dois gatilhos, ja existentes, ganham a mesma nocao de "final":
--
--   1. `fn_atualizar_estoque_reservado` (por item): um item so mexe em
--      `estoque_reservado` quando o PEDIDO ao qual pertence NAO esta num
--      estado final no momento do INSERT/UPDATE/DELETE. Pedido nascido
--      `Entregue` — o caso da venda manual — nunca reserva nada: a baixa
--      fisica de `baixar_estoque_organizacao`, sozinha, e o efeito completo.
--
--   2. `fn_atualizar_reserva_status_pedido` (por pedido, na mudanca de
--      status): libera reserva na transicao de nao-final para QUALQUER
--      estado final (`Cancelado` OU `Entregue`, nao so `Cancelado`), e
--      re-reserva na transicao inversa. Entre dois finais (`Entregue` <->
--      `Cancelado`) nao ha o que fazer — nenhum dos dois nunca reservou.
--
-- Isso fecha os DOIS casos medidos: a venda manual pura (nunca reserva) e a
-- tomada da linha do webhook (a reserva que o webhook fez enquanto o pedido
-- era `Pendente` e liberada no exato instante em que a venda manual muda o
-- status para `Entregue`, antes de a funcao tocar os itens).
--
-- `registrar_venda_manual` e `baixar_estoque_organizacao` NAO MUDAM. A baixa
-- fisica continua sendo o unico efeito de estoque de uma venda manual — o que
-- estava sobrando era a reserva, nao a baixa.
--
-- ---------------------------------------------------------------------------
-- O QUE NAO MUDA, E O QUE MUDA DE PROPOSITO
-- ---------------------------------------------------------------------------
-- Um pedido importado do Bling ainda `Pendente` continua reservando ao
-- receber seus itens — exatamente como antes. `estoque` desses pedidos so
-- muda por sincronizacao de produto (`processProdutoEvent`), nunca por este
-- gatilho; a reserva continua sendo o unico sinal local de compromisso ate a
-- entrega ou o cancelamento.
--
-- Os dois gatilhos daqui sao COMPARTILHADOS — nao existe caminho separado
-- para venda manual e para webhook. Entao um pedido puramente do Bling que
-- transicione PARA `Entregue` (sem venda manual nenhuma por perto) tambem
-- passa a liberar a reserva nesse instante, onde antes ficava presa para
-- sempre. Nao e efeito colateral tolerado: e a MESMA correcao, e vale para
-- qualquer pedido que passe por `Entregue`, nao so os da venda manual. Prova
-- por transicao, sem passar pela RPC nenhuma vez, em
-- `supabase/tests/database/migration_58_invariantes_de_reserva.test.sql`.
--
-- ---------------------------------------------------------------------------
-- O ESTADO EXISTENTE, NAO TOCADO
-- ---------------------------------------------------------------------------
-- Esta migration troca so o COMPORTAMENTO FUTURO dos dois gatilhos (nenhuma
-- DDL de tabela, nenhum UPDATE de linha). Vendas manuais ja gravadas antes
-- dela continuam com `estoque_reservado` inflado pelo defeito — a correcao
-- nao e retroativa. O tamanho real do desvio em dados de producao esta
-- medido, e nao corrigido aqui, em
-- `.scratch/orbita-refinamento-confiabilidade/evidence/30-impacto-da-migration-57-e-58-2026-09-03.md`.

-- ---------------------------------------------------------------------------
-- 1. Gatilho por item — nao reserva para pedido em estado final.
-- ---------------------------------------------------------------------------
create or replace function fn_atualizar_estoque_reservado() returns trigger language plpgsql set search_path = public as $$
declare
    v_pedido_finalizado boolean;
begin
    if (tg_op = 'DELETE') then
        select (status in ('Cancelado', 'Entregue')) into v_pedido_finalizado from pedidos where id = old.pedido_id;
    else
        select (status in ('Cancelado', 'Entregue')) into v_pedido_finalizado from pedidos where id = new.pedido_id;
    end if;

    if (v_pedido_finalizado = true) then
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

-- ---------------------------------------------------------------------------
-- 2. Gatilho por pedido — liberta/re-reserva na fronteira "final <-> nao final",
--    nao mais so na fronteira "Cancelado <-> resto".
-- ---------------------------------------------------------------------------
create or replace function fn_atualizar_reserva_status_pedido() returns trigger language plpgsql set search_path = public as $$
declare
    v_old_finalizado boolean := old.status in ('Cancelado', 'Entregue');
    v_new_finalizado boolean := new.status in ('Cancelado', 'Entregue');
begin
    if (v_new_finalizado and not v_old_finalizado) then
        -- Sai de um estado que reservava (ex.: Pendente) para um final
        -- (Entregue ou Cancelado): a reserva feita ate aqui e liberada. E
        -- exatamente o que acontece quando a venda manual assume a linha que
        -- o webhook criou como Pendente e a marca Entregue.
        update produtos p set estoque_reservado = p.estoque_reservado - coalesce(i.quantidade, 0)
        from itens_pedido i where i.pedido_id = new.id and i.produto_id = p.id;
    elsif (not v_new_finalizado and v_old_finalizado) then
        -- Volta de um final para um estado que reserva: a reserva e refeita.
        update produtos p set estoque_reservado = p.estoque_reservado + coalesce(i.quantidade, 0)
        from itens_pedido i where i.pedido_id = new.id and i.produto_id = p.id;
    end if;
    -- Final -> final (Entregue <-> Cancelado): nenhum dos dois lados reserva,
    -- nao ha o que mexer.
    return new;
end;
$$;
