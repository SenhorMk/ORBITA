-- 61_titulo_financeiro_vinculado_ao_pedido.sql
-- Forward-only. Fatia P0 de coerência financeira.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO ESTRUTURAL
-- ---------------------------------------------------------------------------
-- `titulos_financeiros` não sabia de que pedido cada título veio. A venda
-- manual gravava a única pista dentro do TEXTO da descrição
-- (`Venda manual <bling_id>`), e texto não é relacionamento: nada podia
-- reagir ao cancelamento de um pedido, porque nada sabia quais títulos eram
-- dele.
--
-- Consequência medida no staging: um pedido revertido no ERP continuava
-- somando receita ativa, porque o título seguia `receber/pago` para sempre.
--
-- ---------------------------------------------------------------------------
-- A REGRA (decisão da proprietária)
-- ---------------------------------------------------------------------------
-- Pedido cancelado não continua como receita financeira ativa — e nada é
-- apagado. O título vai para um estado terminal coerente:
--
--   `aberto` -> `cancelado`   (não houve liquidação)
--   `pago`   -> `estornado`   (houve, e a venda foi revertida)
--
-- Os dois permanecem no histórico e na auditoria; saem apenas dos totais
-- ativos. Venda nova, troca ou correção criam pedido NOVO e título NOVO — a
-- venda antiga nunca é reescrita para parecer a nova.
--
-- ---------------------------------------------------------------------------
-- ONDE A CONVERGÊNCIA MORA, E POR QUÊ
-- ---------------------------------------------------------------------------
-- Três caminhos deixam um pedido `Cancelado`: o webhook de exclusão do Bling
-- (`markCancelledByBlingId`), a sincronização de situação (`order.updated`
-- trazendo cancelado) e o cancelamento pedido pelo ORBITA
-- (`/api/pedidos/status`). Espalhar a convergência pelos três é convidar o
-- quarto caminho a esquecer dela.
--
-- Ela vive num GATILHO sobre `pedidos`: assim é atômica com a própria
-- mudança de status (não existe janela com pedido cancelado e título ativo),
-- vale para os três caminhos de uma vez, e é idempotente — reentrega do
-- webhook não encontra mais nada em `aberto`/`pago` para mover.
--
-- REINTRODUZIR O DEFEITO: remova o gatilho
-- `tg_pedidos_converge_titulos_cancelados`. O pgTAP
-- `titulo_financeiro_vinculado_ao_pedido.test.sql` falha nas asserções de
-- cancelamento.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. O VÍNCULO, à prova de cruzamento entre organizações.
-- ---------------------------------------------------------------------------
-- A FK é COMPOSTA — `(pedido_id, organizacao_id)` — de propósito. Uma FK só
-- por `pedido_id` deixaria um título de uma organização apontar para o pedido
-- de outra; com a chave composta, o banco recusa por construção, sem depender
-- de nenhum predicado na aplicação.
alter table public.pedidos
    drop constraint if exists uq_pedidos_id_organizacao;
alter table public.pedidos
    add constraint uq_pedidos_id_organizacao unique (id, organizacao_id);

alter table public.titulos_financeiros
    add column if not exists pedido_id uuid;

-- `nullable` de propósito: títulos importados do Bling (contas a pagar, por
-- exemplo) não pertencem a pedido nenhum, e forçá-los a um vínculo inventado
-- seria pior do que não ter vínculo.
alter table public.titulos_financeiros
    drop constraint if exists fk_titulos_financeiros_pedido;
alter table public.titulos_financeiros
    add constraint fk_titulos_financeiros_pedido
    foreign key (pedido_id, organizacao_id)
    references public.pedidos(id, organizacao_id)
    on delete set null;

-- Uma venda gera UM título de cada tipo. Sem isto, uma reexecução de
-- `registrar_venda_manual` — retentativa, reentrega, tomada da linha do
-- webhook — duplicaria a receita do mesmo pedido.
create unique index if not exists uq_titulo_por_pedido_e_tipo
    on public.titulos_financeiros(organizacao_id, pedido_id, tipo)
    where pedido_id is not null;

create index if not exists idx_titulos_financeiros_pedido
    on public.titulos_financeiros(pedido_id)
    where pedido_id is not null;

-- ---------------------------------------------------------------------------
-- 2. OS ESTADOS TERMINAIS, explicitados.
-- ---------------------------------------------------------------------------
-- `situacao` era texto livre. Os dois estados novos existem agora no domínio,
-- e o CHECK impede que um quinto valor apareça por digitação e escape das
-- métricas em silêncio.
alter table public.titulos_financeiros
    drop constraint if exists titulos_financeiros_situacao_check;
alter table public.titulos_financeiros
    add constraint titulos_financeiros_situacao_check
    check (situacao in ('aberto', 'pago', 'cancelado', 'estornado'));

comment on column public.titulos_financeiros.situacao is
    'aberto | pago = título ativo. cancelado | estornado = terminal: fica no histórico e sai dos totais.';
comment on column public.titulos_financeiros.pedido_id is
    'O pedido que originou este título, quando houver. Nulo para títulos importados que não pertencem a pedido local.';

-- ---------------------------------------------------------------------------
-- 3. A CONVERGÊNCIA.
-- ---------------------------------------------------------------------------
create or replace function public.fn_converge_titulos_do_pedido_cancelado()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    -- Só a ENTRADA em cancelado dispara. Um pedido que já estava cancelado e
    -- é tocado de novo (reentrega do webhook, ressincronização) não encontra
    -- mais nada em `aberto`/`pago`, então repetir é inócuo.
    if new.status = 'Cancelado' and old.status is distinct from 'Cancelado' then
        update public.titulos_financeiros
           set situacao = case situacao when 'pago' then 'estornado' else 'cancelado' end
         where pedido_id = new.id
           and organizacao_id = new.organizacao_id
           and situacao in ('aberto', 'pago');
    end if;
    return new;
end;
$$;

drop trigger if exists tg_pedidos_converge_titulos_cancelados on public.pedidos;
create trigger tg_pedidos_converge_titulos_cancelados
    after update of status on public.pedidos
    for each row execute function public.fn_converge_titulos_do_pedido_cancelado();

-- ---------------------------------------------------------------------------
-- 4. A VENDA MANUAL passa a gravar o vínculo.
-- ---------------------------------------------------------------------------
-- Idêntica à da migration 57 exceto pelo título: `pedido_id` preenchido e
-- `on conflict do nothing`, que torna a gravação do financeiro idempotente
-- junto com o resto da venda.
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

        perform public.baixar_estoque_organizacao(
            p_organizacao_id, v_produto_id, v_quantidade, p_actor_id
        );
    end loop;

    -- O TÍTULO agora nasce vinculado. `do nothing` porque o índice único por
    -- (organizacao, pedido, tipo) é o que garante "uma venda, um título": uma
    -- reexecução converge em vez de duplicar a receita.
    insert into public.titulos_financeiros (
        user_id, organizacao_id, pedido_id, tipo, situacao, valor,
        data_vencimento, data_pagamento, descricao
    )
    values (
        p_actor_id, p_organizacao_id, v_pedido_id, 'receber', 'pago', p_total,
        p_data, p_data,
        'Venda manual ' || coalesce(p_bling_pedido_id, p_numero, v_pedido_id::text)
    )
    on conflict (organizacao_id, pedido_id, tipo) where pedido_id is not null do nothing;

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
-- 5. BACKFILL do vínculo que já dá para provar.
-- ---------------------------------------------------------------------------
-- Só correspondência EXATA: o `bling_id` extraído da descrição tem de bater
-- com o `bling_id` de um pedido da MESMA organização. Nada de aproximar por
-- valor ou data — associar o título errado é pior que deixá-lo sem vínculo.
--
-- Títulos cujo pedido não existe mais localmente continuam sem vínculo, e é
-- assim que devem ficar: o vínculo é um fato, não uma inferência.
update public.titulos_financeiros t
   set pedido_id = p.id
  from public.pedidos p
 where t.pedido_id is null
   and p.organizacao_id = t.organizacao_id
   and p.bling_id = substring(t.descricao from 'Venda manual ([0-9]+)')
   and not exists (
       select 1 from public.titulos_financeiros outro
        where outro.organizacao_id = t.organizacao_id
          and outro.pedido_id = p.id
          and outro.tipo = t.tipo
   );

-- E os pedidos que JÁ estão cancelados convergem agora, uma vez, porque o
-- gatilho só age em transições futuras.
update public.titulos_financeiros t
   set situacao = case t.situacao when 'pago' then 'estornado' else 'cancelado' end
  from public.pedidos p
 where t.pedido_id = p.id
   and t.organizacao_id = p.organizacao_id
   and p.status = 'Cancelado'
   and t.situacao in ('aberto', 'pago');
