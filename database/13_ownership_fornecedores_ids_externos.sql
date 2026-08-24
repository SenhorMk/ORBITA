-- ============================================================================
-- 13_ownership_fornecedores_ids_externos.sql
-- Escopa IDs externos (bling_id) por tenant e impede referências financeiras cross-tenant
-- Aplica o padrão OWASP ASVS L2 e Supabase Postgres Best Practices
-- ============================================================================

-- 1. Garantir que a tabela fornecedores possui coluna user_id e RLS estrita
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fornecedores' AND column_name = 'user_id'
    ) THEN
        ALTER TABLE public.fornecedores
        ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;
END $$;

ALTER TABLE public.fornecedores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable all access for fornecedores" ON public.fornecedores;
DROP POLICY IF EXISTS "Isolamento por tenant" ON public.fornecedores;

CREATE POLICY "Isolamento por tenant"
ON public.fornecedores
FOR ALL
USING ((select auth.uid()) = user_id)
WITH CHECK ((select auth.uid()) = user_id);

CREATE INDEX IF NOT EXISTS idx_fornecedores_user_id ON public.fornecedores(user_id);

-- 2. Remover Constraints Unique Globais em bling_id para permitir múltiplos tenants com mesmos IDs externos
DO $$
BEGIN
    -- Remover constraints unique globais se existirem
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categorias_financeiras_bling_id_key') THEN
        ALTER TABLE public.categorias_financeiras DROP CONSTRAINT categorias_financeiras_bling_id_key;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'titulos_financeiros_bling_id_key') THEN
        ALTER TABLE public.titulos_financeiros DROP CONSTRAINT titulos_financeiros_bling_id_key;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contas_financeiras_bling_id_key') THEN
        ALTER TABLE public.contas_financeiras DROP CONSTRAINT contas_financeiras_bling_id_key;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fornecedores_bling_id_key') THEN
        ALTER TABLE public.fornecedores DROP CONSTRAINT fornecedores_bling_id_key;
    END IF;
END $$;

-- 3. Criar Índices Únicos Compostos Escopados por Tenant (user_id, bling_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_categorias_financeiras_tenant_bling
    ON public.categorias_financeiras (user_id, bling_id)
    WHERE bling_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_titulos_financeiros_tenant_bling
    ON public.titulos_financeiros (user_id, bling_id)
    WHERE bling_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_contas_financeiras_tenant_bling
    ON public.contas_financeiras (user_id, bling_id)
    WHERE bling_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_fornecedores_tenant_bling
    ON public.fornecedores (user_id, bling_id)
    WHERE bling_id IS NOT NULL;

-- 4. Função e Trigger para Impedir Referências Cross-Tenant em Títulos Financeiros
CREATE OR REPLACE FUNCTION public.fn_validar_tenancy_titulos_financeiros()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    IF NEW.categoria_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.categorias_financeiras WHERE id = NEW.categoria_id AND user_id = NEW.user_id) THEN
            RAISE EXCEPTION 'Violação de isolamento: categoria_id % não pertence ao tenant %', NEW.categoria_id, NEW.user_id
                USING ERRCODE = '23503';
        END IF;
    END IF;

    IF NEW.conta_financeira_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.contas_financeiras WHERE id = NEW.conta_financeira_id AND user_id = NEW.user_id) THEN
            RAISE EXCEPTION 'Violação de isolamento: conta_financeira_id % não pertence ao tenant %', NEW.conta_financeira_id, NEW.user_id
                USING ERRCODE = '23503';
        END IF;
    END IF;

    IF NEW.fornecedor_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.fornecedores WHERE id = NEW.fornecedor_id AND user_id = NEW.user_id) THEN
            RAISE EXCEPTION 'Violação de isolamento: fornecedor_id % não pertence ao tenant %', NEW.fornecedor_id, NEW.user_id
                USING ERRCODE = '23503';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validar_tenancy_titulos_financeiros ON public.titulos_financeiros;
CREATE TRIGGER trg_validar_tenancy_titulos_financeiros
BEFORE INSERT OR UPDATE ON public.titulos_financeiros
FOR EACH ROW EXECUTE FUNCTION public.fn_validar_tenancy_titulos_financeiros();
