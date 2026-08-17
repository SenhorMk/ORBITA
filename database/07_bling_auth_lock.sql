-- 07_bling_auth_lock.sql
-- Adiciona controle de concorrência distribuído (Lock) para renovação do token do Bling

-- 1. Adicionar a coluna de lock (se não existir)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='integracoes_bling' AND column_name='refresh_locked_at') THEN
        ALTER TABLE integracoes_bling ADD COLUMN refresh_locked_at timestamp with time zone;
    END IF;
END $$;

-- 2. Função RPC atômica para adquirir o lock
CREATE OR REPLACE FUNCTION acquire_bling_token_lock(p_user_id uuid, p_timeout_seconds int DEFAULT 30)
RETURNS boolean AS $$
DECLARE
    v_locked_at timestamp with time zone;
    v_now timestamp with time zone;
BEGIN
    v_now := now();

    -- Selecionar a linha com travamento (FOR UPDATE)
    SELECT refresh_locked_at INTO v_locked_at
    FROM integracoes_bling
    WHERE user_id = p_user_id
    FOR UPDATE;

    -- Se não existir a integração, não tem como renovar
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- Se não estiver lockado OU se o lock expirou (timeout)
    IF v_locked_at IS NULL OR v_locked_at < (v_now - (p_timeout_seconds || ' seconds')::interval) THEN
        -- Adquirir o lock
        UPDATE integracoes_bling
        SET refresh_locked_at = v_now
        WHERE user_id = p_user_id;
        
        RETURN true;
    ELSE
        -- Outro processo já adquiriu o lock e está rodando
        RETURN false;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
