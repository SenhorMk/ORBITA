-- Empty-database normalization before 09_harden_grants_and_rpcs.sql.
-- The bootstrap reference already contains the scoped signatures, while the
-- historical hardening migration intentionally recreates them with CREATE.
drop function if exists public.decrement_estoque(uuid, uuid, integer);
drop function if exists public.try_nfe_lock(uuid, uuid);
drop function if exists public.unlock_nfe(uuid, uuid);
