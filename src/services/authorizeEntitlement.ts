/**
 * authorizeEntitlement.ts
 * Ticket 13: Application service único de autorização de entitlement/ciclo de vida.
 *
 * Toda operação mutável do MVP relacionada a planos/entitlements/ciclo de vida deve
 * chamar `authorizeEntitlement(scope, operation)` antes de qualquer efeito. Nenhuma
 * rota deve reimplementar `if plano === ...` / `if status === ...` — a decisão vem
 * sempre daqui, que delega ao domínio puro (`entitlementPolicy`/`subscriptionLifecycle`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { evaluateEntitlementPolicy, type EntitlementOperation } from '@/domain/entitlements/entitlementPolicy';
import { loadOrganizationEntitlementSnapshot, type OrganizationEntitlementSnapshot } from '@/repositories/entitlementLifecycleRepository';

export class EntitlementDeniedError extends Error {
  readonly code: 'LIFECYCLE_BLOCKED' | 'FEATURE_NOT_INCLUDED' | 'LIMIT_EXCEEDED';
  readonly operation: string;

  constructor(code: 'LIFECYCLE_BLOCKED' | 'FEATURE_NOT_INCLUDED' | 'LIMIT_EXCEEDED', operation: string, message: string) {
    super(message);
    this.name = 'EntitlementDeniedError';
    this.code = code;
    this.operation = operation;
  }
}

export interface EntitlementAuthorization {
  readonly snapshot: OrganizationEntitlementSnapshot;
}

/**
 * Autoriza (ou nega) uma operação para a organização do escopo verificado.
 *
 * Lança `EntitlementDeniedError` quando a operação é negada, para uso direto em
 * rotas/serviços que devem interromper o fluxo antes de qualquer efeito (mutação de
 * banco, chamada a provider, envio). Nunca aceita `organizacao_id`/plano enviados
 * pelo cliente como autoridade — `scope` já foi verificado contra a membership
 * persistida (`verifyOrganizationScope`).
 */
export async function authorizeEntitlement(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  operation: EntitlementOperation,
): Promise<EntitlementAuthorization> {
  const snapshot = await loadOrganizationEntitlementSnapshot(supabase, scope.organizationId);

  const decision = evaluateEntitlementPolicy(snapshot.state, operation, snapshot.limits, snapshot.usage);

  if (!decision.allowed) {
    throw new EntitlementDeniedError(decision.code, operation.name, decision.reason);
  }

  return { snapshot };
}
