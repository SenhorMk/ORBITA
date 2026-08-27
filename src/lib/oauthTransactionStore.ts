import type { SupabaseClient } from '@supabase/supabase-js';

/** Provider recognised by the durable OAuth transaction store. */
export type OAuthProvider = 'bling';

/** Input required to persist a new single-use OAuth transaction. */
export interface OAuthTransactionCreateInput {
  readonly actorId: string;
  readonly organizacaoId: string | undefined;
  readonly provider: OAuthProvider;
  readonly stateHash: string;
  readonly expiresAt: number;
}

/** Outcome of persisting a new OAuth transaction. */
export type OAuthTransactionStoreCreateResult =
  | { readonly _tag: 'OAuthTransactionStored'; readonly id: string }
  | { readonly _tag: 'OAuthTransactionStoreUnavailable'; readonly cause: string };

/** Outcome of an atomic single-use consumption attempt. */
export type OAuthTransactionStoreConsumeResult =
  | { readonly _tag: 'OAuthTransactionConsumed'; readonly actorId: string; readonly organizacaoId: string | undefined }
  | { readonly _tag: 'OAuthTransactionConsumeDenied' }
  | { readonly _tag: 'OAuthTransactionStoreUnavailable'; readonly cause: string };

/** Durable, server-side, single-use OAuth transaction capability. */
export interface OAuthTransactionStorePort {
  readonly create: (input: OAuthTransactionCreateInput) => Promise<OAuthTransactionStoreCreateResult>;
  readonly consume: (
    id: string,
    stateHash: string,
    now: number,
  ) => Promise<OAuthTransactionStoreConsumeResult>;
}

/** Production adapter backed by the `transacoes_oauth` table and its CAS RPC. */
export function createSupabaseOAuthTransactionStore(client: SupabaseClient): OAuthTransactionStorePort {
  return {
    async create(input) {
      const { data, error } = await client
        .from('transacoes_oauth')
        .insert({
          actor_id: input.actorId,
          organizacao_id: input.organizacaoId ?? null,
          provedor: input.provider,
          state_hash: input.stateHash,
          expira_em: new Date(input.expiresAt).toISOString(),
        })
        .select('id')
        .single();

      if (error || !data?.id) {
        return { _tag: 'OAuthTransactionStoreUnavailable', cause: error?.message ?? 'insert-returned-no-id' };
      }

      return { _tag: 'OAuthTransactionStored', id: data.id as string };
    },

    async consume(id, stateHash, now) {
      const { data, error } = await client.rpc('consumir_transacao_oauth', {
        p_id: id,
        p_state_hash: stateHash,
        p_agora: new Date(now).toISOString(),
      });

      if (error) {
        return { _tag: 'OAuthTransactionStoreUnavailable', cause: error.message };
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.consumido) {
        return { _tag: 'OAuthTransactionConsumeDenied' };
      }

      return {
        _tag: 'OAuthTransactionConsumed',
        actorId: row.actor_id as string,
        organizacaoId: (row.organizacao_id as string | null) ?? undefined,
      };
    },
  };
}
