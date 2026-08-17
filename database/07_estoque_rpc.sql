-- Migration for atomic stock decrement to prevent overselling race conditions
CREATE OR REPLACE FUNCTION decrement_estoque(p_produto_id UUID, p_qty INTEGER)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE produtos
    SET estoque = GREATEST(0, estoque - p_qty)
    WHERE id = p_produto_id;
END;
$$;
