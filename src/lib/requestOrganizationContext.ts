import { NextResponse } from 'next/server';
import { supabaseServer } from './supabaseServer';
import {
  resolveOrganizationContext,
  activeOrganizationSelection,
  verifyRequestIdentity,
  organizationContextStatus,
  organizationCapabilitiesForRole,
  type OrganizationCapability,
  type OrganizationContextResult,
  type OrganizationSelection,
} from './organizationAuthorization';
import {
  organizationContextToScope,
  verifyOrganizationScope,
  type VerifiedOrganizationScope,
} from './verifiedOrganizationScope';
import { SupabaseOrganizationMemberships } from '@/repositories/organizationMembershipRepository';

const memberships = new SupabaseOrganizationMemberships(supabaseServer);

/** Resolve organization authority using the production Auth and Supabase adapters. */
export function resolveRequestOrganizationContext(
  request: Request,
  selection: OrganizationSelection | null,
): Promise<OrganizationContextResult> {
  return resolveOrganizationContext(request, selection, {
    verifyIdentity: verifyRequestIdentity,
    memberships,
  });
}

/** Resolve the request's active cookie, or its first persisted membership when no cookie exists. */
export function resolveActiveRequestOrganizationContext(
  request: Request,
): Promise<OrganizationContextResult> {
  return resolveRequestOrganizationContext(request, activeOrganizationSelection());
}

/** Outcome of resolving a verified organization scope for one HTTP request. */
export type RequestOrganizationScopeResult =
  | { readonly _tag: 'RequestScopeResolved'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'RequestScopeDenied'; readonly response: NextResponse };

/**
 * Resolve the caller's verified organization scope for the active request's
 * membership, or a ready-to-return denial response. Centralizes the
 * organization-context boundary so route handlers never derive
 * `organizacao_id` from client-supplied input.
 */
export async function resolveVerifiedOrganizationScope(request: Request): Promise<RequestOrganizationScopeResult> {
  const contextResult = await resolveActiveRequestOrganizationContext(request);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return {
      _tag: 'RequestScopeDenied',
      response: NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      ),
    };
  }
  return { _tag: 'RequestScopeResolved', scope: organizationContextToScope(contextResult.context) };
}

/** Tagged outcome of authorizing one capability against the organization named in the URL. */
export type RequestOrganizationCapabilityResult =
  | { readonly _tag: 'OrganizationCapabilityAuthorized'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'OrganizationCapabilityDenied'; readonly status: 401 | 403 | 503 };

/**
 * Authorize one capability against an organization named by the request path.
 *
 * `resolveActiveRequestOrganizationContext` answers "who is the caller, in the
 * organization they are currently in". Routes under `/organizacoes/[id]` ask a
 * different question: "may this caller do X *in that* organization" — so the
 * membership is looked up for the exact pair, and the role that comes back
 * decides the capability.
 *
 * Ticket 20 — the three denials this replaces all collapsed into `401` through
 * `verifySessionAndRole`, which returns `null` for "no session" and for "no
 * membership" alike. A member who had just proven who they were was told the
 * server did not know them. The distinction is kept here instead:
 *
 * - no session, or an invalid one → `401`;
 * - authenticated, but without the capability in that organization → `403`;
 * - identity provider or membership store unreachable → `503`.
 *
 * Denial does not distinguish "that organization has no such membership" from
 * "that organization does not exist": both are `403`, so the answer never
 * confirms an organization the caller is not in.
 */
export async function authorizeRequestOrganizationCapability(
  request: Request,
  organizationId: string,
  capability: OrganizationCapability,
): Promise<RequestOrganizationCapabilityResult> {
  const identity = await verifyRequestIdentity(request);
  if (identity._tag !== 'IdentityVerified') {
    return {
      _tag: 'OrganizationCapabilityDenied',
      status: identity._tag === 'IdentityProviderUnavailable' ? 503 : 401,
    };
  }

  const scopeResult = await verifyOrganizationScope(supabaseServer, {
    organizationId,
    actorId: identity.user.id,
  });
  if (scopeResult._tag === 'OrganizationScopeStoreUnavailable') {
    return { _tag: 'OrganizationCapabilityDenied', status: 503 };
  }
  if (scopeResult._tag !== 'OrganizationScopeVerified') {
    return { _tag: 'OrganizationCapabilityDenied', status: 403 };
  }

  if (!organizationCapabilitiesForRole(scopeResult.scope.role).has(capability)) {
    return { _tag: 'OrganizationCapabilityDenied', status: 403 };
  }

  return { _tag: 'OrganizationCapabilityAuthorized', scope: scopeResult.scope };
}

/**
 * A capacidade que o papel do escopo já verificado concede.
 *
 * Existe para as rotas que faziam `session.role !== 'dono'`: aquele papel vinha
 * de `app_metadata`, do modelo antigo de tenancy por usuário, e não tem relação
 * com o papel que a pessoa tem *na organização*. A pergunta certa é sobre a
 * capacidade, e a fonte certa é o vínculo persistido (Ticket 22).
 */
export function escopoTemCapacidade(
  scope: VerifiedOrganizationScope,
  capability: OrganizationCapability,
): boolean {
  return organizationCapabilitiesForRole(scope.role).has(capability);
}
