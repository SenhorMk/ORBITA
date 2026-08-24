-- ============================================================================
-- 14_expand_modelo_fiscal_canonico.sql
-- Ticket 18: Expandir o modelo fiscal canônico (Fase 1: Expand)
-- Introduz a tabela canônica documentos_fiscais com RLS, índices compostos
-- e dual-write trigger para garantir compatibilidade retroativa total com nfes.
-- ============================================================================

-- 1. Criar tabela canônica documentos_fiscais
CREATE TABLE IF NOT EXISTS public.documentos_fiscais (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    pedido_id       UUID REFERENCES public.pedidos(id) ON DELETE SET NULL,
    bling_id        TEXT,
    tipo            TEXT NOT NULL DEFAULT 'NFE' CHECK (tipo IN ('NFE', 'NFCE', 'NFSE', 'OUTRO')),
    numero          TEXT NOT NULL,
    serie           TEXT,
    chave_acesso    TEXT,
    status          TEXT NOT NULL DEFAULT 'Emitida' CHECK (status IN ('Pendente', 'Emitida', 'Cancelada', 'Rejeitada')),
    valor_total     NUMERIC(12, 2),
    xml_url         TEXT,
    danfe_url       TEXT,
    emitida_em      TIMESTAMPTZ,
    dados_extras    JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Habilitar RLS e criar políticas de isolamento por tenant
ALTER TABLE public.documentos_fiscais ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Isolamento por tenant" ON public.documentos_fiscais;
CREATE POLICY "Isolamento por tenant"
ON public.documentos_fiscais
FOR ALL
USING ((select auth.uid()) = user_id)
WITH CHECK ((select auth.uid()) = user_id);

-- 3. Grants para documentos_fiscais
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documentos_fiscais TO authenticated;
GRANT ALL ON public.documentos_fiscais TO service_role;

-- 4. Índices de performance e unicidade por tenant
CREATE INDEX IF NOT EXISTS idx_documentos_fiscais_user_id ON public.documentos_fiscais(user_id);
CREATE INDEX IF NOT EXISTS idx_documentos_fiscais_pedido_id ON public.documentos_fiscais(pedido_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_documentos_fiscais_tenant_bling
    ON public.documentos_fiscais (user_id, bling_id)
    WHERE bling_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_documentos_fiscais_tenant_pedido
    ON public.documentos_fiscais (user_id, pedido_id)
    WHERE pedido_id IS NOT NULL;

-- 5. Trigger de dual-write: escritas em nfes (legado) propagam automaticamente para documentos_fiscais (canônico)
CREATE OR REPLACE FUNCTION public.fn_sync_nfes_to_documentos_fiscais()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
    VALUES (
        NEW.id,
        NEW.user_id,
        NEW.pedido_id,
        NEW.bling_id,
        'NFE',
        NEW.numero,
        NEW.chave,
        NEW.status,
        NEW.emitida_em,
        NEW.created_at,
        NEW.updated_at
    )
    ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        pedido_id = EXCLUDED.pedido_id,
        bling_id = EXCLUDED.bling_id,
        numero = EXCLUDED.numero,
        chave_acesso = EXCLUDED.chave_acesso,
        status = EXCLUDED.status,
        emitida_em = EXCLUDED.emitida_em,
        updated_at = EXCLUDED.updated_at;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_nfes_to_documentos_fiscais ON public.nfes;
CREATE TRIGGER trg_sync_nfes_to_documentos_fiscais
AFTER INSERT OR UPDATE ON public.nfes
FOR EACH ROW EXECUTE FUNCTION public.fn_sync_nfes_to_documentos_fiscais();
