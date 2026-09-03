-- 57_venda_manual_assume_linha_do_webhook.sql
-- Forward-only. Ticket 30.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO
-- ---------------------------------------------------------------------------
-- A venda manual com sincronizacao NUNCA conseguia se completar, porque ela
-- corria contra o proprio webhook — e perdia.
--
-- A ordem nao pode ser invertida: `bling_id` so existe depois que
-- `POST /pedidos/vendas` responde. Entao o pedido nasce no Bling, o Bling
-- dispara `order.created`, e o webhook do ticket 11 grava a linha em `pedidos`
-- com `origem = 'Bling'` em MENOS DE UM SEGUNDO. Quando
-- `registrar_venda_manual` chega para gravar o mesmo `bling_id`, o indice
-- unico ja esta ocupado:
--
--   23505 duplicate key value violates unique constraint "uq_pedidos_org_bling"
--
-- A venda falha, a compensacao tenta cancelar no Bling, e o resultado e um
-- pedido que existe dos dois lados SEM baixa de estoque e SEM titulo
-- financeiro — uma venda pela metade que nao parece.
--
-- Medido em 2026-09-02, com linha do tempo do `inbox_eventos_bling` e a recusa
-- reproduzida em transacao revertida:
-- `.scratch/orbita-refinamento-confiabilidade/evidence/12-jornada-ui-2026-09-02.md`.
--
-- ---------------------------------------------------------------------------
-- A CORRECAO, E POR QUE ESTA E NAO AS OUTRAS DUAS
-- ---------------------------------------------------------------------------
-- Levantamento com medicao em
-- `evidence/30-levantamento-das-tres-saidas-2026-09-03.md`.
--
-- O indice `uq_pedidos_org_bling` FICA. Ele esta certo: o pedido e unico por
-- organizacao. E `23505` NAO vira sucesso. O que muda e que o conflito passa a
-- ser resolvido por REGRA em vez de derrubar a venda:
--
--   `(organizacao_id, bling_id)` nomeia UM pedido, e a venda manual acabou de
--   criar ESSE pedido. A linha com aquele `bling_id` e, por construcao, a
--   mesma venda — nao uma segunda venda.
--
-- Entao a venda manual ASSUME a linha do webhook em vez de inserir outra:
-- completa o que falta (origem, forma de pagamento, itens, baixa de estoque,
-- titulo financeiro) em cima da linha existente.
--
-- As alternativas descartadas, em uma linha cada:
--
--   * O webhook reconhecer o proprio eco pelo `numeroLoja` e viavel — o campo
--     esta em `VendasDadosBaseDTO` e foi observado no payload real —, mas o
--     webhook nao distingue criacao de atualizacao, e a regra faria o ORBITA
--     parar de enxergar mudanca de situacao feita no Bling justamente nos
--     pedidos que ele mesmo cria. Isso desfaria o ticket 11 nessa fatia.
--   * Gravar localmente antes de enviar e impossivel sem `bling_id`, e o
--     substituto (gravar nulo e preencher depois) troca o tudo-ou-nada do
--     ticket 10 por duas fases com compensacao nova — e ainda assim o webhook
--     passaria a correr contra o UPDATE.
--
-- ---------------------------------------------------------------------------
-- O QUE A TOMADA NAO RESOLVE, DE PROPOSITO
-- ---------------------------------------------------------------------------
-- Ela fecha a ordem "webhook primeiro". Na ordem inversa a venda inteira
-- existe — pedido, itens, baixa e titulo —, mas o upsert do webhook
-- sobrescreve `status`, `numero`, `total`, `data` e `user_id`. Ele NAO
-- sobrescreve `origem`, `forma_pagamento`, `observacao`, `desconto` nem
-- `frete`, porque nao os carrega no payload. Isso e o comportamento do ticket
-- 11 para qualquer pedido sincronizado, nao um efeito novo desta migration, e
-- o teste acoplado exercita as duas ordens para que fique visivel.

-- ---------------------------------------------------------------------------
-- `registrar_venda_manual` — identica a versao da migration 56 exceto pelas
-- duas clausulas ON CONFLICT e pela guarda de tomada indevida.
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

    -- A TOMADA DA LINHA DO WEBHOOK.
    --
    -- `uq_pedidos_org_bling` deixou de ser parcial na migration 55, entao
    -- `(organizacao_id, bling_id)` e inferivel sem repetir predicado nenhum.
    --
    -- Quando `p_bling_pedido_id` e NULL — venda sem sincronizacao — o
    -- ON CONFLICT nunca dispara: em PostgreSQL NULL nunca conflita com NULL num
    -- indice unico. A mesma instrucao serve aos dois caminhos.
    --
    -- `numero`: o webhook grava o numero REAL do pedido no Bling; a venda
    -- manual so tem o id. Preserva-se o que ja estiver la.
    insert into public.pedidos (
        user_id, organizacao_id, cliente_id, bling_id, numero, data,
        total, desconto, frete, status, origem, forma_pagamento, observacao
    )
    values (
        p_actor_id, p_organizacao_id, p_cliente_id, p_bling_pedido_id, p_numero,
        p_data::timestamptz, p_total, coalesce(p_desconto, 0), coalesce(p_frete, 0),
        'Entregue', 'Loja Física / Manual', p_forma_pagamento, p_observacoes
    )
    on conflict (organizacao_id, bling_id) do update
        set user_id         = excluded.user_id,
            cliente_id      = excluded.cliente_id,
            numero          = coalesce(pedidos.numero, excluded.numero),
            data            = excluded.data,
            total           = excluded.total,
            desconto        = excluded.desconto,
            frete           = excluded.frete,
            status          = excluded.status,
            origem          = excluded.origem,
            forma_pagamento = excluded.forma_pagamento,
            observacao      = excluded.observacao
        -- A guarda: so se assume linha que NAO e uma venda manual. Assumir uma
        -- que ja e duplicaria baixa de estoque e titulo financeiro. Quando a
        -- condicao nao vale, o DO UPDATE nao acontece, o RETURNING nao devolve
        -- linha, e a funcao levanta logo abaixo. `23505` continua sendo falha.
        where pedidos.origem <> 'Loja Física / Manual'
    returning id into v_pedido_id;

    if v_pedido_id is null then
        raise exception 'Ja existe uma venda manual registrada para o pedido % nesta organizacao.', p_bling_pedido_id
            using errcode = '23505';
    end if;

    for v_item in select * from jsonb_array_elements(p_itens)
    loop
        v_produto_id := (v_item->>'produto_id')::uuid;
        v_quantidade := (v_item->>'quantidade')::integer;
        v_valor_unitario := (v_item->>'valor_unitario')::numeric;

        -- O webhook pode ter gravado o mesmo item antes. Ele nunca grava MAIS
        -- itens que a venda tem — `buildPedidoItemsParaSalvar` pula o item cujo
        -- produto nao existe localmente —, entao uma tomada nunca deixa item
        -- orfao para tras.
        --
        -- O UPDATE de mesma quantidade tem delta zero em
        -- `tg_atualizar_estoque_reservado`: a reserva do webhook e reaproveitada
        -- em vez de somar duas vezes.
        insert into public.itens_pedido (
            user_id, organizacao_id, pedido_id, produto_id, quantidade, valor_unitario
        )
        values (
            p_actor_id, p_organizacao_id, v_pedido_id, v_produto_id, v_quantidade, v_valor_unitario
        )
        on conflict (pedido_id, produto_id) do update
            set user_id        = excluded.user_id,
                organizacao_id = excluded.organizacao_id,
                quantidade     = excluded.quantidade,
                valor_unitario = excluded.valor_unitario;

        -- Revalida produto x organizacao, recusa estoque negativo e registra
        -- QUEM deu a baixa. Roda uma vez por item, com ou sem tomada.
        perform public.baixar_estoque_organizacao(
            p_organizacao_id, v_produto_id, v_quantidade, p_actor_id
        );
    end loop;

    -- O webhook nunca cria titulo financeiro, e a guarda acima impede assumir
    -- uma venda manual ja registrada. Entao este insert acontece exatamente uma
    -- vez por venda.
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
