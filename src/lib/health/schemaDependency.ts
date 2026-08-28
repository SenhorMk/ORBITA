import { supabaseServer } from '@/lib/supabaseServer';
import type { DependencyCheck } from './dependencyCheck';

/** Minimal baseline tables that only exist once the core multi-tenant migrations ran. */
const REQUIRED_BASELINE_TABLES = ['organizacoes', 'membros_organizacao'] as const;

/**
 * Production startup dependency: proves the database already carries the expected baseline
 * schema (i.e. migrations ran as a prior, observable step) with one read-only query per
 * required table. Never returns provider detail to the caller.
 */
export const schemaDependency: DependencyCheck = {
  name: 'schema',
  async check(signal: AbortSignal) {
    for (const table of REQUIRED_BASELINE_TABLES) {
      const { error } = await supabaseServer.from(table).select('*', { head: true, count: 'exact' }).abortSignal(signal);
      if (error) return { ok: false };
    }
    return { ok: true };
  },
};
