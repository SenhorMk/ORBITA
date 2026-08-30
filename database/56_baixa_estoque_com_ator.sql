-- 56_baixa_estoque_com_ator.sql
-- Forward-only.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO
-- ---------------------------------------------------------------------------
-- Toda venda manual falhava, e falhava do pior jeito possivel: o pedido era
-- criado no Bling e DEPOIS a gravacao local era recusada pelo banco.
--
--   null value in column "user_id" of relation "movimentacao_estoque"
--   violates not-null constraint
--
-- `registrar_venda_manual` recebe `p_actor_id` e o grava em `pedidos`,
-- `itens_pedido` e `titulos_financeiros`. So `baixar_estoque_organizacao`, que
-- ela chama no meio do laco, nunca recebeu o ator — a assinatura da migration
-- 40 e `(p_organizacao_id, p_produto_id, p_qty)` — e insere em
-- `movimentacao_estoque` sem `user_id`, que continua NOT NULL.
--
-- Reproduzido em producao em 2026-08-30 as 23:04, pelo roteiro
-- `scripts/verificar-jornada-bling.mjs --escrever`. O pedido 26735607230 ficou
-- orfao na conta Bling do proprietario: existe la, nao existe aqui.
--
-- ---------------------------------------------------------------------------
-- POR QUE PROPAGAR O ATOR EM VEZ DE AFROUXAR A COLUNA
-- ---------------------------------------------------------------------------
-- A alternativa obvia seria `alter column user_id drop not null`, seguindo o
-- que a migration 45 fez no financeiro. Duas razoes contra:
--
--   1. O ator ESTA disponivel. `registrar_venda_manual` ja o tem em maos e ja
--      o grava nas tres tabelas irmas da mesma transacao. Perder o "quem deu
--      baixa" so nesta seria uma degradacao gratuita do rastro de auditoria.
--   2. O dominio comercial ainda nao contraiu. `clientes`, `produtos`,
--      `categorias`, `pedidos`, `itens_pedido` e `documentos_fiscais` seguem
--      com `user_id NOT NULL`. Afrouxar so `movimentacao_estoque` deixaria a
--      tabela fora de sintonia com as irmas, sem nenhuma migracao de contracao
--      que justificasse.
--
-- O dominio comercial pode contrair um dia, como o financeiro contraiu. Quando
-- contrair, contrai inteiro e de proposito — nao por acidente de uma coluna
-- esquecida numa funcao.

-- ---------------------------------------------------------------------------
-- 1. `baixar_estoque_organizacao` passa a receber o ator.
--
-- Assinatura nova (4 argumentos). A antiga e removida logo abaixo para que
-- nenhuma chamada de 3 argumentos resolva silenciosamente para a versao que
-- nao grava o ator.
-- ---------------------------------------------------------------------------
create or replace function public.baixar_estoque_organizacao(
    p_organizacao_id uuid,
    p_produto_id uuid,
    p_qty integer,
    p_actor_id uuid
)
returns table (produto_id uuid, estoque_restante integer)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_estoque_restante integer;
begin
    if p_qty <= 0 then
        raise exception 'Quantidade deve ser maior que zero.' using errcode = '22023';
    end if;

    if p_actor_id is null then
        raise exception 'Ator e obrigatorio para registrar a movimentacao de estoque.' using errcode = '22023';
    end if;

    update public.produtos
    set estoque = estoque - p_qty
    where id = p_produto_id
      and organizacao_id = p_organizacao_id
      and estoque >= p_qty
    returning estoque into v_estoque_restante;

    if not found then
        if exists (
            select 1 from public.produtos
            where id = p_produto_id and organizacao_id = p_organizacao_id
        ) then
            raise exception 'Estoque insuficiente para o produto.' using errcode = '23514';
        end if;
        raise exception 'Produto nao encontrado para a organizacao verificada.' using errcode = 'P0002';
    end if;

    insert into public.movimentacao_estoque (
        user_id, organizacao_id, produto_id, tipo, origem, quantidade
    )
    values (
        p_actor_id, p_organizacao_id, p_produto_id, 'SAIDA', 'BAIXA_ORGANIZACAO_VERIFICADA', p_qty
    );

    return query select p_produto_id, v_estoque_restante;
end;
$$;

revoke all on function public.baixar_estoque_organizacao(uuid, uuid, integer, uuid)
    from public, anon, authenticated;
grant execute on function public.baixar_estoque_organizacao(uuid, uuid, integer, uuid)
    to service_role;

-- ---------------------------------------------------------------------------
-- 2. `registrar_venda_manual` passa o ator adiante.
--
-- Identica a versao da migration 53 exceto pela chamada de baixa de estoque,
-- que agora carrega `p_actor_id`.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_venda_manual(
    p_organizacao_id uuid,
    p_actor_id uuid,
    p_cliente_id uuid,
    p_bling_pedido_id text,
    p_numero text,
    p_total numeric,
    p_desconto numeric,
    p_frete numeric,
    p_forma_pagamento text,
    p_observacoes text,
    p_data date,
    p_itens jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_pedido_id uuid;
    v_item jsonb;
    v_produto_id uuid;
    v_quantidade integer;
    v_valor_unitario numeric(12,2);
begin
    if p_organizacao_id is null or p_actor_id is null or p_cliente_id is null then
        raise exception 'Organizacao, ator e cliente sao obrigatorios.' using errcode = '22023';
    end if;

    if jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
        raise exception 'A venda precisa de ao menos um item.' using errcode = '22023';
    end if;

    if p_total < 0 then
        raise exception 'Total da venda nao pode ser negativo.' using errcode = '22023';
    end if;

    -- O cliente precisa pertencer a mesma organizacao. Sem isso, a service role
    -- poderia vincular a venda a um cliente de outro tenant.
    if not exists (
        select 1 from public.clientes
        where id = p_cliente_id and organizacao_id = p_organizacao_id
    ) then
        raise exception 'Cliente nao encontrado para a organizacao verificada.' using errcode = 'P0002';
    end if;

    insert into public.pedidos (
        user_id, organizacao_id, cliente_id, bling_id, numero, data,
        total, desconto, frete, status, origem, forma_pagamento, observacao
    )
    values (
        p_actor_id, p_organizacao_id, p_cliente_id, p_bling_pedido_id, p_numero,
        p_data::timestamptz, p_total, coalesce(p_desconto, 0), coalesce(p_frete, 0),
        'Entregue', 'Loja Física / Manual', p_forma_pagamento, p_observacoes
    )
    returning id into v_pedido_id;

    for v_item in select * from jsonb_array_elements(p_itens)
    loop
        v_produto_id := (v_item->>'produto_id')::uuid;
        v_quantidade := (v_item->>'quantidade')::integer;
        v_valor_unitario := (v_item->>'valor_unitario')::numeric;

        insert into public.itens_pedido (
            user_id, organizacao_id, pedido_id, produto_id, quantidade, valor_unitario
        )
        values (
            p_actor_id, p_organizacao_id, v_pedido_id, v_produto_id, v_quantidade, v_valor_unitario
        );

        -- Revalida produto x organizacao, recusa estoque negativo e registra
        -- QUEM deu a baixa.
        perform public.baixar_estoque_organizacao(
            p_organizacao_id, v_produto_id, v_quantidade, p_actor_id
        );
    end loop;

    insert into public.titulos_financeiros (
        user_id, organizacao_id, tipo, situacao, valor,
        data_vencimento, data_pagamento, descricao
    )
    values (
        p_actor_id, p_organizacao_id, 'receber', 'pago', p_total,
        p_data, p_data,
        'Venda manual ' || coalesce(p_bling_pedido_id, p_numero, v_pedido_id::text)
    );

    return v_pedido_id;
end;
$$;

revoke all on function public.registrar_venda_manual(
    uuid, uuid, uuid, text, text, numeric, numeric, numeric, text, text, date, jsonb
) from public, anon, authenticated;
grant execute on function public.registrar_venda_manual(
    uuid, uuid, uuid, text, text, numeric, numeric, numeric, text, text, date, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. A assinatura antiga sai.
--
-- Depois que `registrar_venda_manual` passou a chamar a de 4 argumentos, a de
-- 3 nao tem chamador. Mante-la seria manter viva a unica versao capaz de
-- reproduzir o defeito.
-- ---------------------------------------------------------------------------
drop function if exists public.baixar_estoque_organizacao(uuid, uuid, integer);
