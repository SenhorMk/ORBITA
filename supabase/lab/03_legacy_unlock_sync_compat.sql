-- Empty-database compatibility shim for 04_fix_linter_errors.sql.
-- The historical function is revoked there and removed by 09_harden_grants_and_rpcs.sql.
create function public.unlock_sync(p_user_id uuid)
returns boolean
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext(p_user_id::text)::bigint);
$$;

revoke execute on function public.unlock_sync(uuid) from public, anon, authenticated;
