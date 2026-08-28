import { supabaseServer } from '@/lib/supabaseServer';
import type { DependencyCheck } from './dependencyCheck';

/**
 * Production readiness dependency: proves the privileged Supabase client can reach the
 * database with a minimal, read-only query. Never returns provider detail to the caller —
 * only `{ ok: boolean }`, per `evaluateDependencies`'s redaction contract.
 */
export const databaseDependency: DependencyCheck = {
  name: 'database',
  async check(signal: AbortSignal) {
    const { error } = await supabaseServer
      .from('organizacoes')
      .select('id')
      .limit(1)
      .abortSignal(signal);
    return { ok: !error };
  },
};
