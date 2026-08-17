-- Migração 05: Adiciona colunas de detalhes e opcionais à tabela pedidos

ALTER TABLE public.pedidos 
  ADD COLUMN IF NOT EXISTS desconto numeric(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frete numeric(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS observacao text;

-- Atualizar metadados para garantir que clientes de API Supabase identifiquem a estrutura
NOTIFY pgrst, 'reload schema';
