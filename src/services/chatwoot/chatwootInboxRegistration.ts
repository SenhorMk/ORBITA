import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '../../lib/verifiedOrganizationScope';

/** Thrown when a persisted inbox mapping is claimed by a different organization
 * than the one currently authenticated for this connection — a defect, never
 * an expected runtime outcome, because `conexaoId` is already organization-scoped. */
export class ChatwootInboxCrossTenantConflict extends Error {
  readonly _tag = 'ChatwootInboxCrossTenantConflict' as const;

  constructor(
    readonly inboxId: number,
    readonly conexaoId: string,
    readonly expectedOrganizationId: string,
    readonly persistedOrganizationId: string,
  ) {
    super(
      `Chatwoot inbox ${inboxId} for connection ${conexaoId} is mapped to a different organization than the authenticated scope.`,
    );
  }
}

/**
 * Register (or confirm) the durable inbox -> organization/connection mapping
 * before any inbound effect trusts an `inbox_id`. Only call this after the
 * caller has independently authenticated the connection — either a verified
 * webhook signature or an authenticated Application API call made with the
 * organization's own stored credentials. Never call it from unverified input.
 *
 * Idempotent: repeated calls for the same `(conexaoId, inboxId)` are no-ops
 * once the mapping exists, and cross-organization collisions on the same
 * numeric `inbox_id` fail loudly instead of silently overwriting.
 */
export async function registerChatwootInboxIfNeeded(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  params: { readonly conexaoId: string; readonly inboxId: number; readonly accountId?: string },
): Promise<void> {
  const { data: existing, error: lookupError } = await supabase
    .from('chatwoot_inboxes')
    .select('id, organizacao_id')
    .eq('conexao_id', params.conexaoId)
    .eq('inbox_id', params.inboxId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Falha ao consultar mapeamento de inbox Chatwoot: ${lookupError.message}`);
  }

  if (existing) {
    if (existing.organizacao_id !== scope.organizationId) {
      throw new ChatwootInboxCrossTenantConflict(
        params.inboxId,
        params.conexaoId,
        scope.organizationId,
        existing.organizacao_id,
      );
    }
    return;
  }

  const { error: insertError } = await supabase.from('chatwoot_inboxes').insert({
    organizacao_id: scope.organizationId,
    conexao_id: params.conexaoId,
    inbox_id: params.inboxId,
    account_id: params.accountId ?? null,
    user_id: scope.actorId,
  });

  if (insertError) {
    // A concurrent registration racing to insert the same (conexao_id, inbox_id)
    // pair is expected and safe under the unique index; only a real failure is reported.
    if (insertError.code !== '23505') {
      throw new Error(`Falha ao registrar mapeamento de inbox Chatwoot: ${insertError.message}`);
    }
  }
}
