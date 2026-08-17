-- ========================================================================================
-- PLANO DE IMPLEMENTAÇÃO: MÓDULO FINANCEIRO (ESPELHO BLING)
-- Supabase Postgres Best Practices Aplicadas
-- ========================================================================================

-- 1. Criação das Categorias Financeiras
CREATE TABLE IF NOT EXISTS public.categorias_financeiras (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bling_id bigint UNIQUE,
    descricao text NOT NULL,
    tipo text CHECK (tipo IN ('receita', 'despesa')),
    cor text,
    created_at timestamptz DEFAULT now()
);

-- 2. Criação dos Títulos Financeiros (Espelho do Bling)
CREATE TABLE IF NOT EXISTS public.titulos_financeiros (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bling_id bigint UNIQUE, -- ID do título no Bling
    tipo text NOT NULL CHECK (tipo IN ('receber', 'pagar')),
    situacao text NOT NULL, -- 'aberto', 'pago', 'cancelado', etc.
    valor numeric(10, 2) NOT NULL,
    data_vencimento date NOT NULL,
    data_pagamento date,
    descricao text NOT NULL,
    categoria_id uuid REFERENCES public.categorias_financeiras(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 3. Índices de Performance (Supabase Best Practices)
-- Foreign Key index (Evita full table scan em JOINs e DELETEs)
CREATE INDEX IF NOT EXISTS idx_titulos_categoria ON public.titulos_financeiros(categoria_id);
-- Índice para filtragem rápida no Dashboard
CREATE INDEX IF NOT EXISTS idx_titulos_situacao_tipo ON public.titulos_financeiros(situacao, tipo);
-- Índice para filtros de datas no fluxo de caixa
CREATE INDEX IF NOT EXISTS idx_titulos_datas ON public.titulos_financeiros(data_vencimento, data_pagamento);

-- 4. Habilitar RLS (Row Level Security)
ALTER TABLE public.categorias_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.titulos_financeiros ENABLE ROW LEVEL SECURITY;

-- 5. Criar Políticas (Policies)
-- Permitir acesso para a Role Service (A API do Next usa Service Role)
-- Se precisar acessar via frontend (Anon/Authenticated), use policies específicas
CREATE POLICY "Enable all access for categorias_financeiras" 
ON public.categorias_financeiras 
FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Enable all access for titulos_financeiros" 
ON public.titulos_financeiros 
FOR ALL USING (true) WITH CHECK (true);

-- 6. Inserir Categorias Básicas Iniciais
INSERT INTO public.categorias_financeiras (descricao, tipo, cor)
VALUES 
    ('Vendas de Produtos', 'receita', '#10B981'), -- Emerald 500
    ('Matéria-Prima', 'despesa', '#F43F5E'),     -- Rose 500
    ('Embalagens', 'despesa', '#8B5CF6'),        -- Violet 500
    ('Frete e Logística', 'despesa', '#F59E0B'), -- Amber 500
    ('Marketing', 'despesa', '#06B6D4'),         -- Cyan 500
    ('Outros Gastos', 'despesa', '#64748B')      -- Slate 500
ON CONFLICT DO NOTHING;
