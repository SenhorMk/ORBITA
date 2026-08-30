-- 53_venda_manual_transacional.sql
-- Forward-only.
--
-- Duas correcoes da venda manual, ambas descobertas no Ticket 30:
--
-- 1. `pedidos.bling_id` e `pedidos.numero` eram NOT NULL, entao uma venda nao
--    sincronizada precisava inventar um valor. A versao original gravava
--    `MANUAL-<Math.random()>` na coluna `bling_id`, um identificador ficticio
--    se passando por ID do ERP. O Ticket 30 trocou por `local:<uuid>`, honesto
--    mas ainda ocupando a coluna do provedor. Agora as colunas aceitam NULL:
--    sem Bling, nao ha id do Bling.
--
-- 2. A venda era gravada em quatro chamadas separadas (pedido, itens, baixa de
--    estoque, titulo financeiro). Uma falha no meio deixava estoque baixado sem
--    titulo, ou pedido sem itens, sem nenhuma compensacao. `registrar_venda_manual`
--    faz tudo numa transacao unica: ou a venda inteira existe, ou nada existe.

-- ----------------------------------------------------------------------------
-- 1. bling_id/numero passam a ser opcionais.
-- ----------------------------------------------------------------------------
alter table public.pedidos alter column bling_id drop not null;
alter table public.pedidos alter column numero drop not null;

-- `unique_pedido_tenant (user_id, bling_id)` do schema original nao impede
-- multiplos NULL (em PostgreSQL, NULL nunca conflita com NULL num UNIQUE), e
-- `uq_pedidos_org_bling` ja e parcial `where bling_id is not null`. Nada a
-- ajustar nos indices.

-- ----------------------------------------------------------------------------
-- 2. Registro atomico da venda manual.
--
-- `p_itens` e um array JSON de `{ "produto_id": uuid, "quantidade": int,
-- "valor_unitario": numeric }`. Os precos vem do servidor, ja resolvidos contra
-- o cadastro — a funcao nao confia em preco vindo do cliente porque nunca o ve.
--
-- Toda leitura e escrita repete o predicado organizacional, e a baixa de estoque
-- reusa `baixar_estoque_organizacao`, que revalida o produto e recusa estoque
-- negativo.
-- ----------------------------------------------------------------------------
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

        -- Revalida produto x organizacao e recusa estoque negativo.
        perform public.baixar_estoque_organizacao(p_organizacao_id, v_produto_id, v_quantidade);
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

-- ----------------------------------------------------------------------------
-- 3. Grants que a migration 09 revogou e nunca devolveu.
--
-- `sync_state` e lido e escrito em runtime por `src/services/sync.ts` e por
-- `/api/financeiro/sync` usando a service role, mas `service_role` nao tinha
-- privilegio algum — comprovado com `set local role service_role` no
-- laboratorio e no staging (`42501 permission denied`). Sem isto, o sync
-- financeiro falha antes de comecar.
--
-- `integracoes_bling` e `financeiro` NAO recebem grant de proposito: o Ticket
-- 10b removeu todos os leitores de runtime de `integracoes_bling` (a credencial
-- vive no cofre por organizacao) e `financeiro` nao tem chamador nenhum.
-- Conceder privilegio a tabela que ninguem deve usar so reabriria o caminho.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.sync_state to service_role;
