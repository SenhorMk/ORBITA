-- 10_contain_financeiro_domain.sql
-- Forward-only migration: contain the financial domain by adding tenant ownership
-- columns and replacing permissive global policies with user-scoped RLS.
--
-- Context: migrations 06 and 08 created financial tables without user_id, relying
-- on application-layer filtering only. Migration 09 revoked broad grants/functions
-- but did not fix the financial policies. This migration closes that gap.
--
-- Tables affected:
--   public.categorias_financeiras  (created in 06)
--   public.titulos_financeiros     (created in 06)
--   public.contas_financeiras      (created in 08)
--   public.fornecedores            (created in 08)

-- ============================================================================
-- 1. ADD OWNERSHIP COLUMN (idempotent via IF NOT EXISTS)
-- ============================================================================
-- NOTE: Added as nullable first to not break existing rows.
-- A NOT NULL constraint without a DEFAULT would fail if any row exists.
-- The repository already writes user_id on every insert/upsert via the
-- tenant-scoped path established in Ticket 03, so this is safe to land nullable.
-- The NOT NULL constraint tightening is planned for a later baseline/contract ticket.

ALTER TABLE public.categorias_financeiras
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.titulos_financeiros
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.contas_financeiras
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.fornecedores
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- ============================================================================
-- 2. PERFORMANCE INDEXES ON user_id
-- The repository filters every query on user_id; an index is mandatory.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_categorias_financeiras_user
    ON public.categorias_financeiras(user_id);

CREATE INDEX IF NOT EXISTS idx_titulos_financeiros_user
    ON public.titulos_financeiros(user_id);

CREATE INDEX IF NOT EXISTS idx_contas_financeiras_user
    ON public.contas_financeiras(user_id);

CREATE INDEX IF NOT EXISTS idx_fornecedores_user
    ON public.fornecedores(user_id);

-- ============================================================================
-- 3. REMOVE PERMISSIVE GLOBAL POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Enable all access for categorias_financeiras"
    ON public.categorias_financeiras;

DROP POLICY IF EXISTS "Enable all access for titulos_financeiros"
    ON public.titulos_financeiros;

DROP POLICY IF EXISTS "Enable all access for contas_financeiras"
    ON public.contas_financeiras;

DROP POLICY IF EXISTS "Enable all access for fornecedores"
    ON public.fornecedores;

-- ============================================================================
-- 4. TENANT-SCOPED RLS POLICIES (server-side paths only)
-- The browser role (authenticated) is not granted SELECT on these tables
-- (migration 09 already closed that), so these policies guard the
-- service_role path and any future grant upgrade.
-- Using (select auth.uid()) avoids per-row function call overhead.
-- ============================================================================

CREATE POLICY "Isolamento por tenant"
    ON public.categorias_financeiras
    FOR ALL
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Isolamento por tenant"
    ON public.titulos_financeiros
    FOR ALL
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Isolamento por tenant"
    ON public.contas_financeiras
    FOR ALL
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Isolamento por tenant"
    ON public.fornecedores
    FOR ALL
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);

-- ============================================================================
-- 5. ENSURE RLS IS ENABLED (idempotent)
-- ============================================================================

ALTER TABLE public.categorias_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.titulos_financeiros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contas_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fornecedores ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Rollout: apply alongside the application release. The service_role path
-- in financeiroRepository.ts already scopes every query to tenant.id, so
-- the column and policy land cleanly. Existing rows without user_id will
-- be invisible through the policy until a future backfill ticket assigns them.
--
-- Rollback: forward-fix preferred. If needed, restore the permissive policies
-- and drop the user_id columns in a coordinated reverse migration.
-- ============================================================================
