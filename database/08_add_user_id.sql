-- Migration to add user_id for multi-tenant isolation in finance tables

ALTER TABLE titulos_financeiros 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE categorias_financeiras 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE contas_financeiras 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- If you want to enable Row Level Security (RLS) on these tables:
-- ALTER TABLE titulos_financeiros ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Lojista acessa apenas seus titulos" ON titulos_financeiros FOR ALL USING (auth.uid() = user_id);
