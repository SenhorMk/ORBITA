-- ============================================================================
-- 12_quarentena_financeiro_sem_tenant.sql
-- Classifica, isola e quarentena registros financeiros legados com user_id nulo
-- Aplica o padrão OWASP ASVS L2 e Supabase Postgres Best Practices
-- ============================================================================

-- 1. Criação da Tabela de Quarentena Financeira
CREATE TABLE IF NOT EXISTS public.quarentena_financeira (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tabela_origem text NOT NULL,
    registro_id uuid NOT NULL,
    bling_id bigint,
    dados_originais jsonb NOT NULL,
    motivo text NOT NULL DEFAULT 'user_id_ausente',
    status text NOT NULL DEFAULT 'em_quarentena', -- 'em_quarentena', 'atribuido', 'descartado'
    atribuido_para_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    resolvido_em timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_quarentena_status CHECK (status IN ('em_quarentena', 'atribuido', 'descartado')),
    CONSTRAINT uq_quarentena_registro UNIQUE (tabela_origem, registro_id)
);

-- Índices para auditoria e triagem
CREATE INDEX IF NOT EXISTS idx_quarentena_origem ON public.quarentena_financeira(tabela_origem, status);
CREATE INDEX IF NOT EXISTS idx_quarentena_bling_id ON public.quarentena_financeira(bling_id) WHERE bling_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quarentena_atribuido ON public.quarentena_financeira(atribuido_para_user_id) WHERE atribuido_para_user_id IS NOT NULL;

-- 2. Habilitar RLS e Bloquear Acesso Público (Apenas Service Role / Operador de Segurança)
ALTER TABLE public.quarentena_financeira ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acesso restrito quarentena" ON public.quarentena_financeira;
CREATE POLICY "Acesso restrito quarentena"
ON public.quarentena_financeira
FOR ALL
TO authenticated
USING (false)
WITH CHECK (false);

-- Revogar acesso público e anônimo
REVOKE ALL ON TABLE public.quarentena_financeira FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.quarentena_financeira TO service_role;

-- 3. Procedure de Quarentena e Backfill Auditável Idempotente
CREATE OR REPLACE FUNCTION public.quarentenar_registros_financeiros_sem_tenant()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_quarentenados_titulos integer := 0;
    v_quarentenados_categorias integer := 0;
    v_quarentenados_contas integer := 0;
    v_rec record;
BEGIN
    -- A. Quarentenar Títulos Financeiros sem tenant
    FOR v_rec IN
        SELECT id, bling_id, to_jsonb(t) AS payload
        FROM public.titulos_financeiros t
        WHERE user_id IS NULL
    LOOP
        INSERT INTO public.quarentena_financeira (
            tabela_origem,
            registro_id,
            bling_id,
            dados_originais,
            motivo,
            status
        ) VALUES (
            'titulos_financeiros',
            v_rec.id,
            v_rec.bling_id,
            v_rec.payload,
            'user_id_ausente',
            'em_quarentena'
        )
        ON CONFLICT (tabela_origem, registro_id) DO NOTHING;

        -- Remove do catálogo ativo do tenant para não poluir nem violar integridade
        DELETE FROM public.titulos_financeiros WHERE id = v_rec.id;
        v_quarentenados_titulos := v_quarentenados_titulos + 1;
    END LOOP;

    -- B. Quarentenar Categorias Financeiras sem tenant
    FOR v_rec IN
        SELECT id, bling_id, to_jsonb(c) AS payload
        FROM public.categorias_financeiras c
        WHERE user_id IS NULL
    LOOP
        INSERT INTO public.quarentena_financeira (
            tabela_origem,
            registro_id,
            bling_id,
            dados_originais,
            motivo,
            status
        ) VALUES (
            'categorias_financeiras',
            v_rec.id,
            v_rec.bling_id,
            v_rec.payload,
            'user_id_ausente',
            'em_quarentena'
        )
        ON CONFLICT (tabela_origem, registro_id) DO NOTHING;

        DELETE FROM public.categorias_financeiras WHERE id = v_rec.id;
        v_quarentenados_categorias := v_quarentenados_categorias + 1;
    END LOOP;

    -- C. Quarentenar Contas Financeiras sem tenant
    FOR v_rec IN
        SELECT id, bling_id, to_jsonb(ct) AS payload
        FROM public.contas_financeiras ct
        WHERE user_id IS NULL
    LOOP
        INSERT INTO public.quarentena_financeira (
            tabela_origem,
            registro_id,
            bling_id,
            dados_originais,
            motivo,
            status
        ) VALUES (
            'contas_financeiras',
            v_rec.id,
            v_rec.bling_id,
            v_rec.payload,
            'user_id_ausente',
            'em_quarentena'
        )
        ON CONFLICT (tabela_origem, registro_id) DO NOTHING;

        DELETE FROM public.contas_financeiras WHERE id = v_rec.id;
        v_quarentenados_contas := v_quarentenados_contas + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'titulos_quarentenados', v_quarentenados_titulos,
        'categorias_quarentenadas', v_quarentenados_categorias,
        'contas_quarentenadas', v_quarentenados_contas,
        'status', 'concluido'
    );
END;
$$;

-- Revogar execução pública da função de quarentena
REVOKE EXECUTE ON FUNCTION public.quarentenar_registros_financeiros_sem_tenant() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quarentenar_registros_financeiros_sem_tenant() TO service_role;

-- 4. Execução imediata do backfill de quarentena
SELECT public.quarentenar_registros_financeiros_sem_tenant();
