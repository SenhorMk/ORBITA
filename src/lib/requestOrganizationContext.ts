import { NextResponse } from 'next/server';
import { supabaseServer } from './supabaseServer';
import {
  resolveOrganizationContext,
  activeOrganizationSelection,
  verifyRequestIdentity,
  organizationContextStatus,
  type OrganizationContextResult,
  type OrganizationSelection,
} from './organizationAuthorization';
import { organizationContextToScope, type VerifiedOrganizationScope } from './verifiedOrganizationScope';
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
