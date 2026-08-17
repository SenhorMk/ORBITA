-- ============================================================================
-- SCRIPT DE CORREÇÃO DE LINTER (SUPABASE SECURITY ADVISOR)
-- Rode este script no SQL Editor para zerar os avisos de segurança.
-- ============================================================================

-- 1. Corrige as Políticas do Chatwoot (Removendo a regra que permite acesso público irrestrito)
DROP POLICY IF EXISTS "Allow public all on contacts" ON public.chatwoot_contacts;
DROP POLICY IF EXISTS "Allow public all on conversations" ON public.chatwoot_conversations;
DROP POLICY IF EXISTS "Allow public all on messages" ON public.chatwoot_messages;

-- Substituindo por regras seguras (apenas usuários autenticados ou roles de serviço)
CREATE POLICY "Acesso seguro contatos" ON public.chatwoot_contacts FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');
CREATE POLICY "Acesso seguro conversas" ON public.chatwoot_conversations FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');
CREATE POLICY "Acesso seguro mensagens" ON public.chatwoot_messages FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

-- 2. Corrige o "Public Can Execute SECURITY DEFINER Function" da função antiga unlock_sync (se existir)
REVOKE EXECUTE ON FUNCTION public.unlock_sync(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.unlock_sync(UUID) FROM anon;

-- 3. Corrige o aviso "Signed-In Users Can Execute SECURITY DEFINER" 
-- Alterando as funções do sistema para SECURITY INVOKER (Padrão mais seguro, executa com as permissões de quem chamou)
ALTER FUNCTION public.dashboard_stats(UUID) SECURITY INVOKER;
ALTER FUNCTION public.try_advisory_lock_sync(UUID) SECURITY INVOKER;
ALTER FUNCTION public.advisory_unlock_sync(UUID) SECURITY INVOKER;
ALTER FUNCTION public.rpc_criar_pedido_manual(UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, JSONB) SECURITY INVOKER;

-- 4. Garante que os caminhos de pesquisa estão seguros (apenas para garantir que não volte o erro de search_path)
ALTER FUNCTION public.dashboard_stats(UUID) SET search_path = public;
ALTER FUNCTION public.try_advisory_lock_sync(UUID) SET search_path = public;
ALTER FUNCTION public.advisory_unlock_sync(UUID) SET search_path = public;
ALTER FUNCTION public.rpc_criar_pedido_manual(UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, JSONB) SET search_path = public;

-- 5. Corrige o "Auth RLS Initialization Plan" refatorando as políticas RLS para usarem (select auth.uid()) ao invés de auth.uid() puro
-- Isso resolve a lentidão relatada pelo linter da Supabase
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN 
        SELECT unnest(ARRAY['clientes', 'produtos', 'pedidos', 'itens_pedido', 'nfes', 'categorias', 'sync_state', 'integracoes_bling', 'movimentacao_estoque', 'financeiro'])
    LOOP
        EXECUTE format('
            DROP POLICY IF EXISTS "Isolamento por tenant" ON %I;
            CREATE POLICY "Isolamento por tenant" 
            ON %I FOR ALL USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
        ', t, t);
    END LOOP;
END $$;

-- Corrige o aviso "Function Search Path Mutable" para as funções de trigger do sistema
ALTER FUNCTION public.fn_set_updated_at() SET search_path = public;
ALTER FUNCTION public.fn_atualizar_estoque_reservado() SET search_path = public;
ALTER FUNCTION public.fn_atualizar_reserva_status_pedido() SET search_path = public;
ALTER FUNCTION public.fn_validar_estoque_disponivel() SET search_path = public;
ALTER FUNCTION public.fn_validar_exclusao_cliente() SET search_path = public;

DO $$ BEGIN
    -- Tenta corrigir a função fn_atualizar_estoque se ela existir no seu banco (pode ser legado)
    EXECUTE 'ALTER FUNCTION public.fn_atualizar_estoque() SET search_path = public;';
EXCEPTION WHEN OTHERS THEN
    -- ignora se não existir
END $$;

-- Revogar execução de funções vitais pelo público (garantia extra)
REVOKE EXECUTE ON FUNCTION public.dashboard_stats(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.try_advisory_lock_sync(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.advisory_unlock_sync(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.rpc_criar_pedido_manual(UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
