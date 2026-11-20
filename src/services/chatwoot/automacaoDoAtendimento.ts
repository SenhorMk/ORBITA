import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '../../lib/verifiedOrganizationScope';

/** Availability is scoped to the conversation's configured connection. */
export async function automacaoDoAtendimentoAtiva(
  banco: SupabaseClient, escopo: VerifiedOrganizationScope, conversaId: string,
): Promise<boolean> {
  const { data, error } = await banco.rpc('ai_first_disponivel', {
    p_org: escopo.organizationId, p_conversa: conversaId,
  });
  return !error && data === true;
}
