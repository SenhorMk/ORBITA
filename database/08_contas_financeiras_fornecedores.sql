-- ========================================================================================
-- MIGRATION: 08_contas_financeiras_fornecedores.sql
-- Módulo Financeiro: Contas Bancárias/Caixas e Fornecedores
-- Aplica as Supabase Postgres Best Practices (RLS, FK Indexes, Constraints e Types)
-- ========================================================================================

-- 1. Tabela de Contas Financeiras (Bancos & Caixas espelhados do Bling)
CREATE TABLE IF NOT EXISTS public.contas_financeiras (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bling_id bigint UNIQUE,
    descricao text NOT NULL,
    tipo smallint NOT NULL DEFAULT 1, -- 1 = Caixa, 2 = Banco, 3 = Cartão de Crédito, 4 = Outros
    agencia text,
    conta text,
    saldo_inicial numeric(12, 2) DEFAULT 0.00,
    situacao smallint DEFAULT 1, -- 1 = Ativo, 0 = Inativo
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 2. Tabela de Fornecedores (Espelho de Contatos/Fornecedores do Bling)
CREATE TABLE IF NOT EXISTS public.fornecedores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bling_id bigint UNIQUE,
    nome text NOT NULL,
    nome_fantasia text,
    cnpj_cpf text,
    logradouro text,
    numero text,
    bairro text,
    municipio text,
    uf varchar(2),
    cep text,
    telefone text,
    email text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 3. Atualizar Títulos Financeiros para Vincular Banco e Fornecedor
ALTER TABLE public.titulos_financeiros 
    ADD COLUMN IF NOT EXISTS conta_financeira_id uuid REFERENCES public.contas_financeiras(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS fornecedor_id uuid REFERENCES public.fornecedores(id) ON DELETE SET NULL;

-- 4. Índices de Performance (Supabase Best Practices)
-- FK Indexes (Previne Full Table Scans durante JOINs e ON DELETE SET NULL)
CREATE INDEX IF NOT EXISTS idx_titulos_conta_financeira ON public.titulos_financeiros(conta_financeira_id);
CREATE INDEX IF NOT EXISTS idx_titulos_fornecedor ON public.titulos_financeiros(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_contas_financeiras_bling ON public.contas_financeiras(bling_id);
CREATE INDEX IF NOT EXISTS idx_fornecedores_bling ON public.fornecedores(bling_id);

-- Partial Index para consultas ultra-rápidas do fluxo de caixa e alertas de contas em aberto
CREATE INDEX IF NOT EXISTS idx_titulos_abertos_vencimento ON public.titulos_financeiros(data_vencimento) WHERE situacao = 'aberto';

-- 5. Row Level Security (RLS) & Policies
ALTER TABLE public.contas_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fornecedores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all access for contas_financeiras" 
ON public.contas_financeiras 
FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Enable all access for fornecedores" 
ON public.fornecedores 
FOR ALL USING (true) WITH CHECK (true);
