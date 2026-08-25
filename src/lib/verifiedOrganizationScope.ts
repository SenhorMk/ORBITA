import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { OrganizationContext } from './organizationAuthorization';

const verifiedOrganizationScopeBrand: unique symbol = Symbol('VerifiedOrganizationScope');
const organizationActorSchema = z.object({
  organizationId: z.string().uuid(),
  actorId: z.string().uuid(),
});
const organizationRoleSchema = z.enum(['owner', 'admin', 'member']);

/** Organization and actor pair proven against persisted membership server-side. */
export interface VerifiedOrganizationScope {
  readonly organizationId: string;
  readonly actorId: string;
  readonly role: z.infer<typeof organizationRoleSchema>;
  readonly [verifiedOrganizationScopeBrand]: true;
}

export type VerifyOrganizationScopeResult =
  | { readonly _tag: 'OrganizationScopeVerified'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'OrganizationScopeDenied' }
  | { readonly _tag: 'OrganizationScopeStoreUnavailable'; readonly cause: string };

/** Adapt an already verified canonical request context for privileged adapters. */
export function organizationContextToScope(context: OrganizationContext): VerifiedOrganizationScope {
  return {
    organizationId: context.organizationId,
    actorId: context.actorId,
    role: context.role,
    [verifiedOrganizationScopeBrand]: true,
  };
}

/**
 * Verify the exact organization/actor pair before a service-role adapter can use it.
 * The candidate may originate from a session or verified webhook mapping; authority
 * comes from the persisted membership queried here, never from the candidate alone.
 */
export async function verifyOrganizationScope(
  supabase: SupabaseClient,
  candidate: { readonly organizationId: string; readonly actorId: string },
): Promise<VerifyOrganizationScopeResult> {
  const parsedCandidate = organizationActorSchema.safeParse(candidate);
  if (!parsedCandidate.success) return { _tag: 'OrganizationScopeDenied' };

  const { data, error } = await supabase
    .from('membros_organizacao')
    .select('papel')
    .eq('organizacao_id', parsedCandidate.data.organizationId)
    .eq('user_id', parsedCandidate.data.actorId)
    .maybeSingle();
  if (error) {
    return { _tag: 'OrganizationScopeStoreUnavailable', cause: error.message };
  }
  const parsedRole = organizationRoleSchema.safeParse(data?.papel);
  if (!parsedRole.success) return { _tag: 'OrganizationScopeDenied' };

  return {
    _tag: 'OrganizationScopeVerified',
    scope: {
      organizationId: parsedCandidate.data.organizationId,
      actorId: parsedCandidate.data.actorId,
      role: parsedRole.data,
      [verifiedOrganizationScopeBrand]: true,
    },
  };
}
