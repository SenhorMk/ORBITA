import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createSupabaseRateLimitStore } from './rateLimitStore';

/** Minimal fake Supabase client exercising only the `.rpc` surface this adapter calls. */
function fakeClient(
  rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>,
): SupabaseClient {
  return { rpc: rpcImpl } as unknown as SupabaseClient;
}

describe('createSupabaseRateLimitStore (adapter wiring, real object under test)', () => {
  it('calls the registrar_tentativa_limite_taxa RPC with the expected shape and maps an allowed row', async () => {
    let capturedFn = '';
    let capturedArgs: Record<string, unknown> = {};
    const client = fakeClient(async (fn, args) => {
      capturedFn = fn;
      capturedArgs = args;
      return {
        data: [{ permitido: true, contagem: 1, reset_em: '2026-01-01T00:01:00.000Z' }],
        error: null,
      };
    });

    const store = createSupabaseRateLimitStore(client);
    const result = await store.consume('register:203.0.113.10', 5, 60_000, Date.parse('2026-01-01T00:00:00.000Z'));

    expect(capturedFn).toBe('registrar_tentativa_limite_taxa');
    expect(capturedArgs).toEqual({
      p_chave: 'register:203.0.113.10',
      p_limite: 5,
      p_janela_segundos: 60,
      p_agora: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toEqual({
      _tag: 'RateLimitRecorded',
      allowed: true,
      count: 1,
      resetAt: Date.parse('2026-01-01T00:01:00.000Z'),
    });
  });

  it('maps an RPC error to a store-unavailable result, never a silent allow', async () => {
    const client = fakeClient(async () => ({ data: null, error: { message: 'connection refused' } }));
    const store = createSupabaseRateLimitStore(client);

    const result = await store.consume('register:203.0.113.10', 5, 60_000, Date.now());

    expect(result).toEqual({ _tag: 'RateLimitStoreUnavailable', cause: 'connection refused' });
  });
});
