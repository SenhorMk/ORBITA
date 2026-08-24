-- ============================================================================
-- 18_indices_tenancy_consultas.sql
-- Ticket 22: Índices para tenancy, FKs e consultas frequentes
-- Aplica o guia Supabase Postgres Best Practices para indexação de FKs e RLS.
-- ============================================================================

-- 1. Índices para Foreign Keys (evitam locks e table scans)
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id ON public.pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_itens_pedido_pedido_id ON public.itens_pedido(pedido_id);
CREATE INDEX IF NOT EXISTS idx_itens_pedido_produto_id ON public.itens_pedido(produto_id);
CREATE INDEX IF NOT EXISTS idx_titulos_financeiros_categoria_id ON public.titulos_financeiros(categoria_id);
CREATE INDEX IF NOT EXISTS idx_titulos_financeiros_conta_id ON public.titulos_financeiros(conta_financeira_id);
CREATE INDEX IF NOT EXISTS idx_titulos_financeiros_fornecedor_id ON public.titulos_financeiros(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_documentos_fiscais_pedido_id ON public.documentos_fiscais(pedido_id);

-- 2. Índices Compostos para Consultas Frequentes com Tenancy e Ordenação
CREATE INDEX IF NOT EXISTS idx_pedidos_user_data ON public.pedidos(user_id, data DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_user_status ON public.pedidos(user_id, status);
CREATE INDEX IF NOT EXISTS idx_titulos_user_vencimento ON public.titulos_financeiros(user_id, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_titulos_user_tipo_situacao ON public.titulos_financeiros(user_id, tipo, situacao);
CREATE INDEX IF NOT EXISTS idx_mov_estoque_user_prod ON public.movimentacao_estoque(user_id, produto_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatwoot_conv_user_status ON public.chatwoot_conversations(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatwoot_msg_user_conv ON public.chatwoot_messages(user_id, conversation_id, created_at ASC);
