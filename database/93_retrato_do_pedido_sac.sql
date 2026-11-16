-- 93_retrato_do_pedido_sac.sql
-- MSG-011: o retrato de um pedido do cliente confirmado na conversa.
--
-- O QUE MUDA: uma função de leitura,
-- `retrato_do_pedido_verificado_sac(organizacao, conversa, pedido)`, que
-- devolve, num único jsonb, o cabeçalho do pedido, até 50 itens com o estoque
-- de cada produto, o título a receber do pedido e quando cada fonte foi
-- sincronizada pela última vez. O cliente não é parâmetro: vem da prova
-- vigente da MSG-010. Pedido de outro cliente, de outra organização ou
-- inexistente dão a mesma resposta.
--
-- O QUE A FUNÇÃO NÃO FAZ: não escreve (é `stable`; o Postgres recusa INSERT,
-- UPDATE e DELETE dentro dela), não sincroniza com o Bling e não decide nada.
-- Classificar estoque, pagamento e frescor é do domínio
-- (`src/services/sac/retratoDoPedido.ts`). Nenhum dado do cadastro do
-- cliente (documento, telefone, endereço) sai daqui.
--
-- O QUE NÃO MUDA: nenhuma tabela, coluna, índice ou linha. Os índices usados já
-- existem: `idx_itens_pedido_pedido_id`, `uq_titulo_por_pedido_e_tipo`,
-- `sync_state_pkey` e `idx_sync_jobs_org_status`.
--
-- RECUPERAÇÃO: forward-only. Para desligar, revogar o EXECUTE de
-- `service_role` (ver docs/operations/msg-011-runbook.md).

set local lock_timeout = '5s';

create or replace function public.retrato_do_pedido_verificado_sac(
    p_organizacao_id    uuid,
    p_conversa_id_local uuid,
    p_pedido_id         uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_vigente  public.sac_vinculos_cliente;
    v_pedido   public.pedidos;
    v_itens    jsonb;
    v_total    integer;
    v_titulo   jsonb;
    v_ultimo   jsonb;
begin
    if p_organizacao_id is null or p_conversa_id_local is null or p_pedido_id is null then
        raise exception 'MSG-011: consulta do retrato invalida.' using errcode = '22023';
    end if;

    if not exists (select 1 from public.chatwoot_conversations c
                    where c.organizacao_id = p_organizacao_id and c.id_local = p_conversa_id_local) then
        return jsonb_build_object('resultado', 'conversa_inexistente');
    end if;

    v_vigente := public.sac_vinculo_vigente(p_organizacao_id, p_conversa_id_local);
    if v_vigente.id is null then
        return jsonb_build_object('resultado', 'sem_prova');
    end if;

    select p.* into v_pedido
      from public.pedidos p
     where p.id = p_pedido_id
       and p.organizacao_id = p_organizacao_id
       and p.cliente_id = v_vigente.cliente_id;
    if v_pedido.id is null then
        return jsonb_build_object('resultado', 'nao_encontrado');
    end if;

    -- Itens: no máximo 50. O nome e o código vêm do próprio item (o retrato do
    -- momento da venda); o estoque vem do produto da mesma organização. Sem
    -- produto da organização, o item é órfão e o estoque fica nulo.
    select count(*)::int into v_total
      from public.itens_pedido i
     where i.pedido_id = v_pedido.id and i.organizacao_id = p_organizacao_id;

    select coalesce(jsonb_agg(jsonb_build_object(
               'item_id', x.item_id,
               'produto_id', x.produto_id,
               'nome', x.nome,
               'codigo', x.codigo,
               'quantidade', x.quantidade,
               'valor_unitario', x.valor_unitario,
               'produto_situacao', x.produto_situacao,
               'estoque', x.estoque,
               'estoque_reservado', x.estoque_reservado,
               'produto_atualizado_em', x.produto_atualizado_em
           ) order by x.nome, x.item_id), '[]'::jsonb)
      into v_itens
      from (
        select i.id as item_id,
               pr.id as produto_id,
               i.produto_nome as nome,
               i.produto_codigo as codigo,
               i.quantidade,
               i.valor_unitario,
               pr.situacao as produto_situacao,
               pr.estoque,
               pr.estoque_reservado,
               pr.updated_at as produto_atualizado_em
          from public.itens_pedido i
          left join public.produtos pr
            on pr.id = i.produto_id and pr.organizacao_id = p_organizacao_id
         where i.pedido_id = v_pedido.id and i.organizacao_id = p_organizacao_id
         order by i.produto_nome, i.id
         limit 50
      ) x;

    -- O título a receber do pedido (no máximo um, por `uq_titulo_por_pedido_e_tipo`).
    -- Conta a pagar ligada ao pedido não é pagamento do cliente e fica fora.
    select jsonb_build_object(
               'situacao', t.situacao,
               'situacao_bling', t.situacao_bling,
               'valor', t.valor,
               'vencimento', t.data_vencimento,
               'pago_em', t.data_pagamento,
               'atualizado_em', t.updated_at)
      into v_titulo
      from public.titulos_financeiros t
     where t.organizacao_id = p_organizacao_id and t.pedido_id = v_pedido.id and t.tipo = 'receber';

    select jsonb_build_object('status', j.status, 'em', coalesce(j.completed_at, j.updated_at))
      into v_ultimo
      from public.sync_jobs j
     where j.organizacao_id = p_organizacao_id and j.status in ('completed', 'failed')
     order by j.created_at desc
     limit 1;

    return jsonb_build_object(
        'resultado', 'retrato',
        'pedido', jsonb_build_object(
            'pedido_id', v_pedido.id,
            'numero', v_pedido.numero,
            'data', v_pedido.data,
            'status', v_pedido.status,
            'total', v_pedido.total,
            'frete', v_pedido.frete,
            'desconto', v_pedido.desconto,
            'forma_pagamento', v_pedido.forma_pagamento,
            'atualizado_em', v_pedido.updated_at),
        'itens', v_itens,
        'total_de_itens', v_total,
        'titulo', v_titulo,
        'sincronizacao', jsonb_build_object(
            'pedidos', (select s.last_synced_at from public.sync_state s
                         where s.organizacao_id = p_organizacao_id and s.entidade = 'pedidos'),
            'produtos', (select s.last_synced_at from public.sync_state s
                          where s.organizacao_id = p_organizacao_id and s.entidade = 'produtos'),
            'financeiro', (select s.last_synced_at from public.sync_state s
                            where s.organizacao_id = p_organizacao_id and s.entidade = 'financeiro_contas_receber'),
            'ultimo_job', v_ultimo)
    );
end;
$$;

revoke all on function public.retrato_do_pedido_verificado_sac(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.retrato_do_pedido_verificado_sac(uuid, uuid, uuid) to service_role;

-- Autoverificação: o navegador não chega ao retrato, e a função não escreve.
do $$
begin
    if has_function_privilege('authenticated', 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)', 'execute')
       or has_function_privilege('anon', 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)', 'execute')
       or not has_function_privilege('service_role', 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)', 'execute')
       or (select p.provolatile from pg_catalog.pg_proc p
            where p.oid = 'public.retrato_do_pedido_verificado_sac(uuid,uuid,uuid)'::regprocedure) <> 's' then
        raise exception 'MSG-011: retrato exposto ou com escrita.';
    end if;
end;
$$;
