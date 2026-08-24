-- ============================================================================
-- 16_contrair_modelo_fiscal_legado.sql
-- Ticket 20: Contrair o modelo fiscal legado (Fase 3: Contract)
-- Remove a tabela legada nfes após validação prévia de contagem e integridade,
-- consolidando a representação canônica em documentos_fiscais.
-- ============================================================================

DO $$
DECLARE
    v_count_legado BIGINT := 0;
    v_count_canonico BIGINT := 0;
BEGIN
    -- 1. Verificar e validar dados caso nfes ainda exista
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'nfes'
    ) THEN
        SELECT count(*) INTO v_count_legado FROM public.nfes;
        SELECT count(*) INTO v_count_canonico FROM public.documentos_fiscais;

        IF v_count_canonico < v_count_legado THEN
            RAISE EXCEPTION 'Contração abortada: documentos_fiscais possui % registros, menos que os % de nfes',
                v_count_canonico, v_count_legado
                USING ERRCODE = '23514';
        END IF;

        -- 2. Remover triggers associados à sincronização da tabela legada
        DROP TRIGGER IF EXISTS trg_sync_nfes_to_documentos_fiscais ON public.nfes;
        DROP FUNCTION IF EXISTS public.fn_sync_nfes_to_documentos_fiscais();
        DROP FUNCTION IF EXISTS public.migrar_nfes_para_documentos_fiscais();

        -- 3. Remover policies legadas
        DROP POLICY IF EXISTS "Isolamento por tenant" ON public.nfes;
        DROP POLICY IF EXISTS "Enable all access for nfes" ON public.nfes;

        -- 4. Dropar tabela legada nfes
        DROP TABLE IF EXISTS public.nfes CASCADE;
    END IF;

    -- 5. Remover tabela drift órfã nfe (singular) se existir
    DROP TABLE IF EXISTS public.nfe CASCADE;
END $$;
