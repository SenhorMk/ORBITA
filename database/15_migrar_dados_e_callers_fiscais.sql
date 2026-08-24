-- ============================================================================
-- 15_migrar_dados_e_callers_fiscais.sql
-- Ticket 19: Migrar dados e callers fiscais (Fase 2: Backfill & Migration)
-- Executa o backfill idempotente de nfes para documentos_fiscais
-- e cria procedure segura para reprocessamento.
-- ============================================================================

-- 1. Procedure de backfill idempotente de nfes para documentos_fiscais
CREATE OR REPLACE FUNCTION public.migrar_nfes_para_documentos_fiscais()
RETURNS TABLE (
    total_migrado BIGINT,
    total_existente BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_migrados BIGINT := 0;
    v_existentes BIGINT := 0;
BEGIN
    SELECT count(*) INTO v_existentes FROM public.documentos_fiscais;

    INSERT INTO public.documentos_fiscais (
        id,
        user_id,
        pedido_id,
        bling_id,
        tipo,
        numero,
        chave_acesso,
        status,
        emitida_em,
        created_at,
        updated_at
    )
    SELECT
        n.id,
        n.user_id,
        n.pedido_id,
        n.bling_id,
        'NFE',
        n.numero,
        n.chave,
        n.status,
        n.emitida_em,
        n.created_at,
        n.updated_at
    FROM public.nfes n
    ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        pedido_id = EXCLUDED.pedido_id,
        bling_id = EXCLUDED.bling_id,
        numero = EXCLUDED.numero,
        chave_acesso = EXCLUDED.chave_acesso,
        status = EXCLUDED.status,
        emitida_em = EXCLUDED.emitida_em,
        updated_at = EXCLUDED.updated_at;

    GET DIAGNOSTICS v_migrados = ROW_COUNT;

    RETURN QUERY SELECT v_migrados, v_existentes;
END;
$$;

REVOKE ALL ON FUNCTION public.migrar_nfes_para_documentos_fiscais() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.migrar_nfes_para_documentos_fiscais() FROM anon;
GRANT EXECUTE ON FUNCTION public.migrar_nfes_para_documentos_fiscais() TO authenticated, service_role;

-- 2. Executar o backfill imediatamente na migration
SELECT public.migrar_nfes_para_documentos_fiscais();
