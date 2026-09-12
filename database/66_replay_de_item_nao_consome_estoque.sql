-- 66_replay_de_item_nao_consome_estoque.sql
-- Forward-only.
--
-- ---------------------------------------------------------------------------
-- INVARIANTE
-- ---------------------------------------------------------------------------
-- A disponibilidade é cobrada pelo AUMENTO da quantidade desta linha de
-- pedido, nunca por reaplicá-la.
--
-- Formalmente, para a chave `(pedido_id, produto_id)`:
--
--     delta = nova quantidade - quantidade já demandada por esta linha
--     delta <= 0                 -> nada a validar, nada é consumido
--     delta >  0                 -> exige estoque - (reservado + delta) >= 0
--
-- Reaplicar o mesmo estado tem delta zero e é aceito. Demanda nova sem
-- disponibilidade continua recusada.
--
-- ---------------------------------------------------------------------------
-- POR QUE A LEITURA DA LINHA VIGENTE É NECESSÁRIA NO RAMO DE INSERT
-- ---------------------------------------------------------------------------
-- `insert ... on conflict (pedido_id, produto_id) do update` dispara o
-- BEFORE **INSERT** antes de resolver o conflito. Nesse instante a linha pode
-- já existir: o insert vai se tornar um update dela. Cobrar `new.quantidade`
-- inteira ali trata o replay como demanda nova, e um item de quantidade 1 já
-- gravado sobre estoque 0 produz `0 - (0 + 1) = -1` — recusa de um estado que
-- não muda nada.
--
-- A quantidade vigente é lida com `for update`, e o produto só é travado
-- quando há delta positivo: o travamento existe para impedir venda além do
-- estoque sob concorrência, e onde não há consumo não há o que serializar.
--
-- As regras de reserva das migrations 58 e 60 seguem intactas — este arquivo
-- não altera `fn_atualizar_estoque_reservado`: pedido finalizado não reserva,
-- venda manual nunca contribui para reserva, e a reserva não fica negativa.
--
-- REINTRODUZIR O DEFEITO: volte o ramo de insert para
-- `v_disp_final := v_erp - (v_reservado + new.quantidade)`. O pgTAP
-- `replay_de_item_nao_consome_estoque.test.sql` falha no replay do item
-- existente sobre estoque zero.
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
    -- Quanto esta linha já demanda hoje.
    if tg_op = 'UPDATE' and old.produto_id = new.produto_id then
        v_demanda_vigente := old.quantidade;
    else
        -- Ramo de insert (e de troca de produto): a linha pode já existir para
        -- esta chave, e então este insert virará um update dela.
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

    select estoque, estoque_reservado
      into v_estoque, v_reservado
      from produtos
     where id = new.produto_id
       for update;

    if not found then
        raise exception 'Produto com ID % não encontrado.', new.produto_id;
    end if;

    if v_estoque - (v_reservado + v_delta) < 0 then
        raise exception 'Estoque insuficiente para o produto "%".', new.produto_id
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;
