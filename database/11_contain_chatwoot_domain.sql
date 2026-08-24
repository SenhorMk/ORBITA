-- 11_contain_chatwoot_domain.sql
-- Forward-only migration: contain the Chatwoot domain by eliminating permissive policies,
-- ensuring tenant ownership columns, creating performance indexes, and enforcing tenant-scoped RLS.
--
-- Tables affected:
--   public.chatwoot_inboxes
--   public.chatwoot_contacts
--   public.chatwoot_conversations
--   public.chatwoot_messages

-- ============================================================================
-- 1. DROP LEGACY AND PERMISSIVE POLICIES
-- ============================================================================

-- Drop broad role-based policies from migration 04
DROP POLICY IF EXISTS "Allow public all on contacts" ON public.chatwoot_contacts;
DROP POLICY IF EXISTS "Allow public all on conversations" ON public.chatwoot_conversations;
DROP POLICY IF EXISTS "Allow public all on messages" ON public.chatwoot_messages;
DROP POLICY IF EXISTS "Acesso seguro contatos" ON public.chatwoot_contacts;
DROP POLICY IF EXISTS "Acesso seguro conversas" ON public.chatwoot_conversations;
DROP POLICY IF EXISTS "Acesso seguro mensagens" ON public.chatwoot_messages;

-- Drop existing tenant isolation policies to recreate cleanly
DROP POLICY IF EXISTS "Isolamento por tenant" ON public.chatwoot_inboxes;
DROP POLICY IF EXISTS "Isolamento por tenant" ON public.chatwoot_contacts;
DROP POLICY IF EXISTS "Isolamento por tenant" ON public.chatwoot_conversations;
DROP POLICY IF EXISTS "Isolamento por tenant" ON public.chatwoot_messages;

-- ============================================================================
-- 2. ENSURE OWNERSHIP COLUMNS (idempotent)
-- ============================================================================

ALTER TABLE public.chatwoot_inboxes
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.chatwoot_contacts
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.chatwoot_conversations
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.chatwoot_messages
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- ============================================================================
-- 3. PERFORMANCE INDEXES ON user_id (Tenant filter hot path)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_chatwoot_inboxes_user ON public.chatwoot_inboxes(user_id);
CREATE INDEX IF NOT EXISTS idx_chatwoot_contacts_user ON public.chatwoot_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_chatwoot_conversations_user ON public.chatwoot_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chatwoot_messages_user ON public.chatwoot_messages(user_id);

-- Foreign key indexes for relational performance
CREATE INDEX IF NOT EXISTS idx_chatwoot_conversations_contact ON public.chatwoot_conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_chatwoot_messages_conversation ON public.chatwoot_messages(conversation_id);

-- ============================================================================
-- 4. ROW LEVEL SECURITY & TENANT-SCOPED POLICIES
-- ============================================================================

ALTER TABLE public.chatwoot_inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatwoot_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatwoot_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatwoot_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Isolamento por tenant"
    ON public.chatwoot_inboxes
    FOR ALL
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Isolamento por tenant"
    ON public.chatwoot_contacts
    FOR ALL
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Isolamento por tenant"
    ON public.chatwoot_conversations
    FOR ALL
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Isolamento por tenant"
    ON public.chatwoot_messages
    FOR ALL
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);
