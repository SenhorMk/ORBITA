-- ============================================================================
-- O.R.B.I.T.A. - SCHEMA MESTRE UNIFICADO (MULTI-TENANT SaaS)
-- Dialeto: PostgreSQL 15+ (Supabase)
-- 
-- Este é o único schema oficial. Substitui todos os outros schemas antigos
-- (schema.sql, migration.sql, multi_tenant_migration.sql, triggers.sql, schema_completo.sql)
-- ============================================================================

-- ============================================================================
-- 1. TABELAS DE DADOS (COM MULTI-TENANCY E RLS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS clientes (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bling_id              TEXT NOT NULL,
    nome                  TEXT NOT NULL,
    cpf_cnpj              TEXT,
    email                 TEXT,
    telefone              TEXT,
    telefone_normalizado  TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_cliente_tenant UNIQUE (user_id, bling_id)
);

CREATE TABLE IF NOT EXISTS produtos (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bling_id             TEXT NOT NULL,
    codigo               TEXT,
    nome                 TEXT NOT NULL,
    preco                NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    imagem_url           TEXT,
    estoque              INT NOT NULL DEFAULT 0,
    estoque_reservado    INT NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_produto_preco        CHECK (preco >= 0.00),
    CONSTRAINT chk_produto_estoque       CHECK (estoque >= 0),
    CONSTRAINT chk_produto_reservado     CHECK (estoque_reservado >= 0),
    CONSTRAINT unique_produto_tenant UNIQUE (user_id, bling_id)
);

CREATE OR REPLACE VIEW v_estoque_disponivel
WITH (security_invoker = true) AS
SELECT
    p.*,
    (p.estoque - p.estoque_reservado) AS estoque_disponivel
FROM produtos p;

CREATE TABLE IF NOT EXISTS pedidos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bling_id        TEXT NOT NULL,
    numero          TEXT NOT NULL,
    data            TIMESTAMPTZ NOT NULL,
    cliente_id      UUID NOT NULL,
    total           NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    frete           NUMERIC(12,2) DEFAULT 0.00,
    desconto        NUMERIC(12,2) DEFAULT 0.00,
    status          TEXT NOT NULL DEFAULT 'Pendente',
    origem          TEXT NOT NULL DEFAULT 'Bling',
    forma_pagamento TEXT,
    observacao      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_pedido_total   CHECK (total >= 0.00),
    CONSTRAINT chk_pedido_status  CHECK (status IN ('Pendente','A Emitir','Atendido','Cancelado','Aberto','Enviado','Concluído')),
    CONSTRAINT fk_pedido_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE RESTRICT,
    CONSTRAINT unique_pedido_tenant UNIQUE (user_id, bling_id)
);

CREATE TABLE IF NOT EXISTS itens_pedido (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    pedido_id       UUID NOT NULL,
    produto_id      UUID NOT NULL,
    quantidade      INT NOT NULL,
    valor_unitario  NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_item_quantidade CHECK (quantidade > 0),
    CONSTRAINT fk_item_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
    CONSTRAINT fk_item_produto FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE RESTRICT,
    CONSTRAINT unq_item_pedido_produto UNIQUE (pedido_id, produto_id)
);

CREATE TABLE IF NOT EXISTS nfes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bling_id     TEXT NOT NULL,
    numero       TEXT NOT NULL,
    chave        TEXT,
    status       TEXT NOT NULL,
    pedido_id    UUID NOT NULL,
    emitida_em   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_nfe_status CHECK (status IN ('Pendente', 'Emitida', 'Cancelada', 'Rejeitada')),
    CONSTRAINT fk_nfe_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
    CONSTRAINT unique_nfe_tenant UNIQUE (user_id, bling_id),
    CONSTRAINT unique_nfe_pedido_tenant UNIQUE (user_id, pedido_id)
);

CREATE TABLE IF NOT EXISTS categorias (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bling_id         TEXT NOT NULL,
    descricao        TEXT NOT NULL,
    categoria_pai_id TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_categoria_tenant UNIQUE (user_id, bling_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    entidade         TEXT NOT NULL,
    last_synced_at   TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, entidade)
);

CREATE TABLE IF NOT EXISTS integracoes_bling (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id        TEXT NOT NULL,
    client_secret    TEXT NOT NULL,
    access_token     TEXT,
    refresh_token    TEXT,
    token_expires_at TIMESTAMPTZ,
    refresh_locked_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_integracao_user UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS movimentacao_estoque (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    produto_id   UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    tipo         TEXT NOT NULL,
    origem       TEXT,
    quantidade   INT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_movimentacao_tipo CHECK (tipo IN ('ENTRADA', 'SAIDA')),
    CONSTRAINT chk_movimentacao_quantidade CHECK (quantidade > 0)
);

CREATE TABLE IF NOT EXISTS financeiro (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    pedido_id        UUID REFERENCES pedidos(id) ON DELETE SET NULL,
    tipo             TEXT NOT NULL,
    valor            NUMERIC(12,2) NOT NULL,
    forma_pagamento  TEXT,
    data_pagamento   TIMESTAMPTZ DEFAULT now(),
    status           TEXT NOT NULL DEFAULT 'PENDENTE',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_financeiro_tipo CHECK (tipo IN ('RECEITA', 'DESPESA')),
    CONSTRAINT chk_financeiro_status CHECK (status IN ('PENDENTE', 'PAGO', 'CANCELADO'))
);

CREATE TABLE IF NOT EXISTS chatwoot_inboxes (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    inbox_id         INT NOT NULL UNIQUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chatwoot_contacts (
    id               INT PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    email            TEXT,
    phone_number     TEXT,
    phone_normalizado TEXT,
    avatar_url       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chatwoot_conversations (
    id               INT PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    display_id       INT,
    contact_id       INT NOT NULL REFERENCES chatwoot_contacts(id) ON DELETE CASCADE,
    status           TEXT NOT NULL,
    inbox_id         INT,
    channel          TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chatwoot_messages (
    id               INT PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    conversation_id  INT NOT NULL REFERENCES chatwoot_conversations(id) ON DELETE CASCADE,
    content          TEXT,
    message_type     TEXT,
    sender_name      TEXT,
    sender_id        INT,
    sender_type      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. POLÍTICAS DE RLS (ROW LEVEL SECURITY)
-- ============================================================================

ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE itens_pedido ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfes ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE integracoes_bling ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimentacao_estoque ENABLE ROW LEVEL SECURITY;
ALTER TABLE financeiro ENABLE ROW LEVEL SECURITY;

-- Tabelas auxiliares do Chatwoot
ALTER TABLE IF EXISTS chatwoot_inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS chatwoot_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS chatwoot_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS chatwoot_messages ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN 
        SELECT unnest(ARRAY['clientes', 'produtos', 'pedidos', 'itens_pedido', 'nfes', 'categorias', 'sync_state', 'integracoes_bling', 'movimentacao_estoque', 'financeiro', 'chatwoot_inboxes', 'chatwoot_contacts', 'chatwoot_conversations', 'chatwoot_messages'])
    LOOP
        EXECUTE format('
            DROP POLICY IF EXISTS "Isolamento por tenant" ON %I;
            CREATE POLICY "Isolamento por tenant" 
            ON %I FOR ALL USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
        ', t, t);
    END LOOP;
END $$;

-- ============================================================================
-- 3. TRIGGERS E REGRAS DE NEGÓCIO (UPDATED_AT E ESTOQUE RESERVADO)
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN 
        SELECT unnest(ARRAY['clientes', 'produtos', 'pedidos', 'itens_pedido', 'nfes', 'sync_state', 'integracoes_bling', 'categorias', 'movimentacao_estoque', 'financeiro'])
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS tg_%I_updated_at ON %I;
            CREATE TRIGGER tg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
        ', t, t, t, t);
    END LOOP;
END $$;

-- Atualizar estoque reservado ao mexer nos itens do pedido
CREATE OR REPLACE FUNCTION fn_atualizar_estoque_reservado() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_pedido_cancelado BOOLEAN;
BEGIN
    IF (TG_OP = 'DELETE') THEN
        SELECT (status = 'Cancelado') INTO v_pedido_cancelado FROM pedidos WHERE id = OLD.pedido_id;
    ELSE
        SELECT (status = 'Cancelado') INTO v_pedido_cancelado FROM pedidos WHERE id = NEW.pedido_id;
    END IF;

    IF (v_pedido_cancelado = TRUE) THEN
        IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;

    IF (TG_OP = 'INSERT') THEN
        UPDATE produtos SET estoque_reservado = estoque_reservado + NEW.quantidade WHERE id = NEW.produto_id;
        RETURN NEW;
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE produtos SET estoque_reservado = estoque_reservado - OLD.quantidade WHERE id = OLD.produto_id;
        RETURN OLD;
    ELSIF (TG_OP = 'UPDATE') THEN
        IF (OLD.produto_id = NEW.produto_id) THEN
            UPDATE produtos SET estoque_reservado = estoque_reservado + (NEW.quantidade - OLD.quantidade) WHERE id = NEW.produto_id;
        ELSE
            UPDATE produtos SET estoque_reservado = estoque_reservado - OLD.quantidade WHERE id = OLD.produto_id;
            UPDATE produtos SET estoque_reservado = estoque_reservado + NEW.quantidade WHERE id = NEW.produto_id;
        END IF;
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tg_atualizar_estoque_reservado ON itens_pedido;
CREATE TRIGGER tg_atualizar_estoque_reservado
AFTER INSERT OR UPDATE OR DELETE ON itens_pedido FOR EACH ROW EXECUTE FUNCTION fn_atualizar_estoque_reservado();

-- Liberar reserva se pedido for cancelado
CREATE OR REPLACE FUNCTION fn_atualizar_reserva_status_pedido() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF (NEW.status = 'Cancelado' AND OLD.status <> 'Cancelado') THEN
        UPDATE produtos p SET estoque_reservado = p.estoque_reservado - COALESCE(i.quantidade, 0) FROM itens_pedido i WHERE i.pedido_id = NEW.id AND i.produto_id = p.id;
    ELSIF (NEW.status <> 'Cancelado' AND OLD.status = 'Cancelado') THEN
        UPDATE produtos p SET estoque_reservado = p.estoque_reservado + COALESCE(i.quantidade, 0) FROM itens_pedido i WHERE i.pedido_id = NEW.id AND i.produto_id = p.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_pedidos_reserva_status ON pedidos;
CREATE TRIGGER tg_pedidos_reserva_status AFTER UPDATE OF status ON pedidos FOR EACH ROW EXECUTE FUNCTION fn_atualizar_reserva_status_pedido();

-- Validação: Não vender sem estoque (CT-008)
CREATE OR REPLACE FUNCTION fn_validar_estoque_disponivel() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_erp INT; v_reservado INT; v_disp_final INT;
BEGIN
    SELECT p.estoque, p.estoque_reservado INTO v_erp, v_reservado FROM produtos p WHERE p.id = NEW.produto_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Produto com ID % não encontrado.', NEW.produto_id; END IF;
    IF (TG_OP = 'UPDATE' AND OLD.produto_id = NEW.produto_id) THEN
        v_disp_final := v_erp - (v_reservado - OLD.quantidade + NEW.quantidade);
    ELSE
        v_disp_final := v_erp - (v_reservado + NEW.quantidade);
    END IF;
    IF v_disp_final < 0 THEN
        RAISE EXCEPTION 'Estoque insuficiente para o produto "%".', NEW.produto_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_validar_estoque_disponivel ON itens_pedido;
CREATE TRIGGER tg_validar_estoque_disponivel BEFORE INSERT OR UPDATE ON itens_pedido FOR EACH ROW EXECUTE FUNCTION fn_validar_estoque_disponivel();

-- Validação Exclusão Cliente (CT-005)
CREATE OR REPLACE FUNCTION fn_validar_exclusao_cliente() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_total_pedidos INT;
BEGIN
    SELECT COUNT(*) INTO v_total_pedidos FROM pedidos WHERE cliente_id = OLD.id;
    IF (v_total_pedidos > 0) THEN
        RAISE EXCEPTION 'Não é permitido excluir cliente "%". Existem % pedido(s).', OLD.nome, v_total_pedidos USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tg_prevenir_exclusao_cliente ON clientes;
CREATE TRIGGER tg_prevenir_exclusao_cliente BEFORE DELETE ON clientes FOR EACH ROW EXECUTE FUNCTION fn_validar_exclusao_cliente();

-- ============================================================================
-- 4. FUNÇÕES DE SUPORTE
-- ============================================================================

-- Server-only RPCs. Every object is fully qualified because search_path is empty.
CREATE OR REPLACE FUNCTION public.dashboard_stats(p_user_id UUID)
RETURNS TABLE (faturamento30 numeric, total bigint, pendentes bigint, cancelados bigint, atendidos bigint)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT
        COALESCE(SUM(p.total) FILTER (
            WHERE p.status <> 'Cancelado'
              AND p.data >= (pg_catalog.now() - INTERVAL '30 days')
        ), 0),
        COUNT(p.id),
        COUNT(p.id) FILTER (WHERE p.status = 'Pendente'),
        COUNT(p.id) FILTER (WHERE p.status = 'Cancelado'),
        COUNT(p.id) FILTER (WHERE p.status IN ('Atendido', 'Enviado'))
    FROM public.pedidos p
    WHERE p.user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.try_advisory_lock_sync(p_user_id UUID)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT pg_catalog.pg_try_advisory_lock(
        ('x' || pg_catalog.substr(pg_catalog.md5(p_user_id::text), 1, 16))::bit(64)::bigint
    );
$$;

CREATE OR REPLACE FUNCTION public.advisory_unlock_sync(p_user_id UUID)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT pg_catalog.pg_advisory_unlock(
        ('x' || pg_catalog.substr(pg_catalog.md5(p_user_id::text), 1, 16))::bit(64)::bigint
    );
$$;

CREATE OR REPLACE FUNCTION public.acquire_bling_token_lock(
    p_user_id UUID,
    p_timeout_seconds INTEGER DEFAULT 30
)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_locked_at TIMESTAMPTZ;
    v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
    IF p_timeout_seconds < 5 OR p_timeout_seconds > 300 THEN
        RAISE EXCEPTION 'Timeout de lock fora do intervalo permitido.' USING ERRCODE = '22023';
    END IF;

    SELECT refresh_locked_at INTO v_locked_at
    FROM public.integracoes_bling
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN RETURN false; END IF;

    IF v_locked_at IS NULL
       OR v_locked_at < v_now - pg_catalog.make_interval(secs => p_timeout_seconds) THEN
        UPDATE public.integracoes_bling
        SET refresh_locked_at = v_now
        WHERE user_id = p_user_id;
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.decrement_estoque(
    p_user_id UUID,
    p_produto_id UUID,
    p_qty INTEGER
)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF p_qty <= 0 THEN
        RAISE EXCEPTION 'Quantidade deve ser maior que zero.' USING ERRCODE = '22023';
    END IF;

    UPDATE public.produtos
    SET estoque = GREATEST(0, estoque - p_qty)
    WHERE id = p_produto_id
      AND user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Produto não encontrado para o tenant.' USING ERRCODE = 'P0002';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.try_nfe_lock(p_user_id UUID, p_pedido_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.pedidos
        WHERE id = p_pedido_id AND user_id = p_user_id
    ) THEN RETURN false; END IF;

    RETURN pg_catalog.pg_try_advisory_lock(
        ('x' || pg_catalog.substr(pg_catalog.md5('nfe_' || p_pedido_id::text), 1, 16))::bit(64)::bigint
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.unlock_nfe(p_user_id UUID, p_pedido_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.pedidos
        WHERE id = p_pedido_id AND user_id = p_user_id
    ) THEN RETURN false; END IF;

    RETURN pg_catalog.pg_advisory_unlock(
        ('x' || pg_catalog.substr(pg_catalog.md5('nfe_' || p_pedido_id::text), 1, 16))::bit(64)::bigint
    );
END;
$$;

-- ============================================================================
-- 5. RPC - PEDIDO MANUAL E TRANSAÇÕES
-- ============================================================================

CREATE OR REPLACE FUNCTION rpc_criar_pedido_manual(
    p_user_id UUID,
    p_cliente_id UUID,
    p_bling_id TEXT,
    p_origem TEXT,
    p_forma_pagamento TEXT,
    p_total NUMERIC,
    p_itens JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_pedido_id UUID;
    v_item JSONB;
    v_produto_id UUID;
    v_quantidade INT;
    v_valor_unitario NUMERIC;
    v_estoque_atual INT;
    v_estoque_reservado INT;
    v_estoque_disponivel INT;
BEGIN
    -- 1. Criar o pedido
    INSERT INTO pedidos (user_id, cliente_id, bling_id, numero, data, total, status, origem, forma_pagamento)
    VALUES (p_user_id, p_cliente_id, p_bling_id, p_bling_id, now(), p_total, 'Concluído', p_origem, p_forma_pagamento)
    RETURNING id INTO v_pedido_id;

    -- 2. Processar itens
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
    LOOP
        v_produto_id := (v_item->>'produto_id')::UUID;
        v_quantidade := (v_item->>'quantidade')::INT;
        v_valor_unitario := (v_item->>'valor_unitario')::NUMERIC;

        -- Verificar estoque atual com LOCK
        SELECT COALESCE(estoque, 0), COALESCE(estoque_reservado, 0) INTO v_estoque_atual, v_estoque_reservado 
        FROM produtos WHERE id = v_produto_id AND user_id = p_user_id FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Produto não encontrado.';
        END IF;

        v_estoque_disponivel := v_estoque_atual - v_estoque_reservado;

        IF v_estoque_disponivel < v_quantidade THEN
            RAISE EXCEPTION 'Estoque insuficiente para o produto %.', v_produto_id;
        END IF;

        -- Inserir item_pedido
        INSERT INTO itens_pedido (user_id, pedido_id, produto_id, quantidade, valor_unitario)
        VALUES (p_user_id, v_pedido_id, v_produto_id, v_quantidade, v_valor_unitario);

        -- Dar baixa no estoque real
        UPDATE produtos SET estoque = estoque - v_quantidade WHERE id = v_produto_id;

        -- Inserir log de movimentação de estoque
        INSERT INTO movimentacao_estoque (user_id, produto_id, tipo, origem, quantidade)
        VALUES (p_user_id, v_produto_id, 'SAIDA', 'PEDIDO_MANUAL:' || v_pedido_id::TEXT, v_quantidade);

    END LOOP;

    -- 3. Registrar no financeiro
    INSERT INTO financeiro (user_id, pedido_id, tipo, valor, forma_pagamento, status)
    VALUES (p_user_id, v_pedido_id, 'RECEITA', p_total, p_forma_pagamento, 'PAGO');

    RETURN v_pedido_id;
END;
$$;

-- ============================================================================
-- 6. CONTAS FINANCEIRAS & FORNECEDORES (SUPABASE POSTGRES BEST PRACTICES)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.contas_financeiras (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bling_id bigint UNIQUE,
    descricao text NOT NULL,
    tipo smallint NOT NULL DEFAULT 1, -- 1 = Caixa, 2 = Banco, 3 = Cartão de Crédito, 4 = Outros
    agencia text,
    conta text,
    saldo_inicial numeric(12, 2) DEFAULT 0.00,
    situacao smallint DEFAULT 1,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

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

ALTER TABLE public.titulos_financeiros 
    ADD COLUMN IF NOT EXISTS conta_financeira_id uuid REFERENCES public.contas_financeiras(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS fornecedor_id uuid REFERENCES public.fornecedores(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_titulos_conta_financeira ON public.titulos_financeiros(conta_financeira_id);
CREATE INDEX IF NOT EXISTS idx_titulos_fornecedor ON public.titulos_financeiros(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_contas_financeiras_bling ON public.contas_financeiras(bling_id);
CREATE INDEX IF NOT EXISTS idx_fornecedores_bling ON public.fornecedores(bling_id);
CREATE INDEX IF NOT EXISTS idx_titulos_abertos_vencimento ON public.titulos_financeiros(data_vencimento) WHERE situacao = 'aberto';

ALTER TABLE public.contas_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fornecedores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all access for contas_financeiras" ON public.contas_financeiras FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Enable all access for fornecedores" ON public.fornecedores FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- 7. LEAST-PRIVILEGE DATA API CLOSURE (MIGRATION 09)
-- ============================================================================

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.clientes TO authenticated;
GRANT SELECT ON TABLE public.produtos TO authenticated;
GRANT SELECT ON TABLE public.itens_pedido TO authenticated;
GRANT SELECT ON TABLE public.chatwoot_contacts TO authenticated;
GRANT SELECT ON TABLE public.chatwoot_conversations TO authenticated;
GRANT SELECT ON TABLE public.chatwoot_messages TO authenticated;

GRANT EXECUTE ON FUNCTION public.dashboard_stats(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.try_advisory_lock_sync(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.advisory_unlock_sync(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_bling_token_lock(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrement_estoque(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.try_nfe_lock(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.unlock_nfe(UUID, UUID) TO service_role;

