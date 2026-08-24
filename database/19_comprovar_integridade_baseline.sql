-- ============================================================================
-- 19_comprovar_integridade_baseline.sql
-- Ticket 23: Comprovar integridade da baseline saneada
-- Cria função e view de auditoria para verificar integridade referencial,
-- ausência de ownership nulo fora da quarentena e isolamento cross-tenant.
-- ============================================================================

create or replace function public.verificar_integridade_baseline()
returns table (
    verificacao text,
    tabela text,
    infracoes bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
    -- 1. Verificar registros com user_id NULO em tabelas operacionais
    return query
    select 'user_id nulo'::text, 'pedidos'::text, count(*) from public.pedidos where user_id is null
    union all
    select 'user_id nulo'::text, 'itens_pedido'::text, count(*) from public.itens_pedido where user_id is null
    union all
    select 'user_id nulo'::text, 'clientes'::text, count(*) from public.clientes where user_id is null
    union all
    select 'user_id nulo'::text, 'produtos'::text, count(*) from public.produtos where user_id is null
    union all
    select 'user_id nulo'::text, 'fornecedores'::text, count(*) from public.fornecedores where user_id is null
    union all
    select 'user_id nulo'::text, 'titulos_financeiros'::text, count(*) from public.titulos_financeiros where user_id is null
    union all
    select 'user_id nulo'::text, 'categorias_financeiras'::text, count(*) from public.categorias_financeiras where user_id is null
    union all
    select 'user_id nulo'::text, 'contas_financeiras'::text, count(*) from public.contas_financeiras where user_id is null
    union all
    select 'user_id nulo'::text, 'documentos_fiscais'::text, count(*) from public.documentos_fiscais where user_id is null
    union all
    select 'user_id nulo'::text, 'movimentacao_estoque'::text, count(*) from public.movimentacao_estoque where user_id is null
    union all
    select 'user_id nulo'::text, 'chatwoot_conversations'::text, count(*) from public.chatwoot_conversations where user_id is null
    union all
    select 'user_id nulo'::text, 'chatwoot_messages'::text, count(*) from public.chatwoot_messages where user_id is null;

    -- 2. Verificar violações cross-tenant (FK apontando para registro de outro tenant)
    return query
    select 'cross-tenant FK'::text, 'titulos_financeiros -> fornecedores'::text, count(*)
    from public.titulos_financeiros t
    join public.fornecedores f on t.fornecedor_id = f.id
    where t.user_id <> f.user_id
    union all
    select 'cross-tenant FK'::text, 'titulos_financeiros -> categorias_financeiras'::text, count(*)
    from public.titulos_financeiros t
    join public.categorias_financeiras c on t.categoria_id = c.id
    where t.user_id <> c.user_id
    union all
    select 'cross-tenant FK'::text, 'titulos_financeiros -> contas_financeiras'::text, count(*)
    from public.titulos_financeiros t
    join public.contas_financeiras c on t.conta_financeira_id = c.id
    where t.user_id <> c.user_id
    union all
    select 'cross-tenant FK'::text, 'itens_pedido -> pedidos'::text, count(*)
    from public.itens_pedido i
    join public.pedidos p on i.pedido_id = p.id
    where i.user_id <> p.user_id
    union all
    select 'cross-tenant FK'::text, 'documentos_fiscais -> pedidos'::text, count(*)
    from public.documentos_fiscais d
    join public.pedidos p on d.pedido_id = p.id
    where d.user_id <> p.user_id
    union all
    select 'cross-tenant FK'::text, 'chatwoot_messages -> chatwoot_conversations'::text, count(*)
    from public.chatwoot_messages m
    join public.chatwoot_conversations c on m.conversation_id = c.id
    where m.user_id <> c.user_id;
end;
$$;

revoke all on function public.verificar_integridade_baseline() from public, anon, authenticated;
grant execute on function public.verificar_integridade_baseline() to service_role;
