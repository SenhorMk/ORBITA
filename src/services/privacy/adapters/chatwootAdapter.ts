/**
 * chatwootAdapter.ts
 * Adapter do sistema "chatwoot" — mesmo mecanismo do `blingAdapter.ts`
 * (enfileiramento no outbox durável; a entrega depende do worker), destino
 * `chatwoot`. Ver
 * `outboxProviderAdapter.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { OutboxProviderAdapter } from './outboxProviderAdapter';
import { SupabaseOutboxTitularPort } from './blingAdapter';

export function createChatwootAdapter(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
): OutboxProviderAdapter {
  return new OutboxProviderAdapter('chatwoot', new SupabaseOutboxTitularPort(supabase, scope));
}
