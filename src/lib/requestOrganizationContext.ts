import { supabaseServer } from './supabaseServer';
import {
  resolveOrganizationContext,
  activeOrganizationSelection,
  verifyRequestIdentity,
  type OrganizationContextResult,
  type OrganizationSelection,
} from './organizationAuthorization';
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
