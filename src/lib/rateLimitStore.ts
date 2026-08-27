import type { SupabaseClient } from '@supabase/supabase-js';

import type { RateLimitStorePort, RateLimitStoreResult } from './rateLimit';

/** Production adapter backed by the `limite_taxa_tentativas` table's atomic RPC. */
export function createSupabaseRateLimitStore(client: SupabaseClient): RateLimitStorePort {
  return {
    async consume(key, limit, windowMs, now): Promise<RateLimitStoreResult> {
      const { data, error } = await client.rpc('registrar_tentativa_limite_taxa', {
        p_chave: key,
        p_limite: limit,
        p_janela_segundos: Math.max(1, Math.round(windowMs / 1_000)),
        p_agora: new Date(now).toISOString(),
      });

      if (error) {
        return { _tag: 'RateLimitStoreUnavailable', cause: error.message };
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        return { _tag: 'RateLimitStoreUnavailable', cause: 'rate-limit-rpc-returned-no-row' };
      }

      return {
        _tag: 'RateLimitRecorded',
        allowed: Boolean(row.permitido),
        count: Number(row.contagem),
        resetAt: new Date(row.reset_em as string).getTime(),
      };
    },
  };
}
