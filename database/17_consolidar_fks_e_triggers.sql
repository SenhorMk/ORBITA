-- ============================================================================
-- 17_consolidar_fks_e_triggers.sql
-- Ticket 21: Consolidar foreign keys e triggers
-- Harmoniza e garante integridade referencial determinística (ON DELETE explícito),
-- search_path seguro em todos os triggers e atualização automática de updated_at
-- em todas as tabelas canônicas.
-- ============================================================================

-- 1. Assegurar search_path = public em todas as trigger functions canônicas
CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- 2. Consolidar triggers de updated_at em todas as tabelas ativas
DO $$
DECLARE
    tbl text;
    active_tables text[] := ARRAY[
        'clientes',
        'produtos',
        'pedidos',
        'itens_pedido',
        'categorias',
        'sync_state',
        'integracoes_bling',
        'movimentacao_estoque',
        'categorias_financeiras',
        'titulos_financeiros',
        'contas_financeiras',
        'fornecedores',
        'documentos_fiscais',
        'chatwoot_inboxes',
        'chatwoot_contacts',
        'chatwoot_conversations',
        'chatwoot_messages'
    ];
BEGIN
    FOREACH tbl IN ARRAY active_tables
    LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'updated_at'
        ) THEN
            EXECUTE format('DROP TRIGGER IF EXISTS tg_%I_updated_at ON public.%I;', tbl, tbl);
            EXECUTE format('CREATE TRIGGER tg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();', tbl, tbl);
        END IF;
    END LOOP;
END $$;

-- 3. Harmonizar FKs financeiras em titulos_financeiros com ON DELETE SET NULL explícito
DO $$
BEGIN
    -- Categoria FK
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'titulos_financeiros_categoria_id_fkey') THEN
        ALTER TABLE public.titulos_financeiros DROP CONSTRAINT titulos_financeiros_categoria_id_fkey;
    END IF;
    ALTER TABLE public.titulos_financeiros
        ADD CONSTRAINT fk_titulos_financeiros_categoria
        FOREIGN KEY (categoria_id) REFERENCES public.categorias_financeiras(id) ON DELETE SET NULL;

    -- Conta Financeira FK
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'titulos_financeiros_conta_financeira_id_fkey') THEN
        ALTER TABLE public.titulos_financeiros DROP CONSTRAINT titulos_financeiros_conta_financeira_id_fkey;
    END IF;
    ALTER TABLE public.titulos_financeiros
        ADD CONSTRAINT fk_titulos_financeiros_conta
        FOREIGN KEY (conta_financeira_id) REFERENCES public.contas_financeiras(id) ON DELETE SET NULL;

    -- Fornecedor FK
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'titulos_financeiros_fornecedor_id_fkey') THEN
        ALTER TABLE public.titulos_financeiros DROP CONSTRAINT titulos_financeiros_fornecedor_id_fkey;
    END IF;
    ALTER TABLE public.titulos_financeiros
        ADD CONSTRAINT fk_titulos_financeiros_fornecedor
        FOREIGN KEY (fornecedor_id) REFERENCES public.fornecedores(id) ON DELETE SET NULL;
END $$;
