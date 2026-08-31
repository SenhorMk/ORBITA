import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { readBearerToken } from './bearer-token';

const actorIdSchema = z.uuid().brand<'ActorId'>();
const tenantIdSchema = z.uuid().brand<'TenantId'>();
const ownerMembershipSchema = z.object({
  role: z.literal('dono'),
  tenant_id: tenantIdSchema.optional(),
});
const collaboratorMembershipSchema = z.object({
  role: z.literal('colaborador'),
  tenant_id: tenantIdSchema,
});
const signedTenantCandidateSchema = z.object({
  tenantId: tenantIdSchema,
  secret: z.string().min(1),
});
const verifiedTenantBrand: unique symbol = Symbol('VerifiedTenant');

/** Minimal authenticated identity returned by the server-side identity provider. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly app_metadata: Record<string, unknown>;
}

/** Narrow port used to verify an access token without coupling authorization to Supabase. */
export interface AuthUserLookup {
  readonly getUser: (token: string) => Promise<{
    readonly data: { readonly user: AuthenticatedUser | null };
    readonly error: {
      readonly message: string;
      readonly status?: number;
      readonly code?: string;
    } | null;
  }>;
}

/** Result of verifying identity only; organization authorization is a separate concern. */
export type AuthenticatedIdentityResult =
  | { readonly _tag: 'IdentityVerified'; readonly user: AuthenticatedUser }
  | { readonly _tag: 'SessionMissing' }
  | { readonly _tag: 'SessionInvalid' }
  | { readonly _tag: 'IdentityProviderUnavailable'; readonly cause: string };

/** Capabilities understood by the temporary user-owned tenancy model. */
export type ActorCapability = 'app:access' | 'tenant:manage';

/** Role asserted by trusted server-controlled membership metadata. */
export type ActorRole = 'dono' | 'colaborador';

/** Tenant scope that can only be created after a trusted authorization check. */
export interface VerifiedTenant {
  readonly id: z.infer<typeof tenantIdSchema>;
  readonly [verifiedTenantBrand]: true;
}

/** Verified actor, membership, capabilities, and tenant for one server operation. */
export interface ActorContext {
  readonly actorId: z.infer<typeof actorIdSchema>;
  readonly user: AuthenticatedUser;
  readonly role: ActorRole;
  readonly capabilities: ReadonlySet<ActorCapability>;
  readonly tenant: VerifiedTenant;
}

/** Safe, tagged outcome of resolving the authenticated actor and authorized tenant. */
export type ActorContextResult =
  | { readonly _tag: 'ActorContextResolved'; readonly context: ActorContext }
  | { readonly _tag: 'SessionMissing' }
  | { readonly _tag: 'SessionInvalid' }
  | { readonly _tag: 'IdentityProviderUnavailable'; readonly cause: string }
  | { readonly _tag: 'MembershipMissing' }
  | { readonly _tag: 'CapabilityDenied'; readonly capability: ActorCapability };

/** A typed authorization denial without the successful context variant. */
export type ActorContextDenial = Exclude<
  ActorContextResult,
  { readonly _tag: 'ActorContextResolved' }
>;

/** Server-owned mapping from a tenant to the secret that signs its webhooks. */
export interface SignedTenantCandidate {
  readonly tenantId: string;
  readonly secret: string;
}

/** Tagged result of authorizing a non-session server workflow for one tenant. */
export type ServiceTenantAuthorizationResult =
  | { readonly _tag: 'ServiceTenantAuthorized'; readonly tenant: VerifiedTenant }
  | { readonly _tag: 'ServiceTenantDenied' };

/** Compatibility alias for callers that have not yet adopted the tagged result. */
export type AuthSession = ActorContext;

const defaultAuthUserLookup: AuthUserLookup = {
  async getUser(token) {
    const { supabaseServer } = await import('./supabaseServer');
    return supabaseServer.auth.getUser(token);
  },
};

/** Verify a bearer session without treating identity-provider metadata as membership authority. */
export async function resolveAuthenticatedIdentity(
  request: Request,
  authUserLookup: AuthUserLookup = defaultAuthUserLookup,
): Promise<AuthenticatedIdentityResult> {
  const bearerResult = readBearerToken(request);
  if (bearerResult._tag !== 'BearerTokenFound') return { _tag: 'SessionMissing' };

  try {
    const { data, error } = await authUserLookup.getUser(bearerResult.token);
    if (error) {
      return error.status !== undefined && error.status < 500 && error.status !== 429
        ? { _tag: 'SessionInvalid' }
        : { _tag: 'IdentityProviderUnavailable', cause: error.code ?? 'auth_provider_error' };
    }
    return data.user
      ? { _tag: 'IdentityVerified', user: data.user }
      : { _tag: 'SessionInvalid' };
  } catch {
    return { _tag: 'IdentityProviderUnavailable', cause: 'auth_provider_unreachable' };
  }
}

function capabilitiesFor(role: ActorRole): ReadonlySet<ActorCapability> {
  return role === 'dono'
    ? new Set(['app:access', 'tenant:manage'])
    : new Set(['app:access']);
}

function resolveLegacyMembership(
  user: AuthenticatedUser,
): Pick<ActorContext, 'actorId' | 'role' | 'capabilities' | 'tenant'> | null {
  const actorIdResult = actorIdSchema.safeParse(user.id);
  if (!actorIdResult.success) {
    return null;
  }

  const ownerResult = ownerMembershipSchema.safeParse(user.app_metadata);
  if (ownerResult.success) {
    const tenantId = ownerResult.data.tenant_id ?? tenantIdSchema.parse(actorIdResult.data);
    return {
      actorId: actorIdResult.data,
      role: 'dono',
      capabilities: capabilitiesFor('dono'),
      tenant: { id: tenantId, [verifiedTenantBrand]: true },
    };
  }

  const collaboratorResult = collaboratorMembershipSchema.safeParse(user.app_metadata);
  if (!collaboratorResult.success) {
    return null;
  }

  return {
    actorId: actorIdResult.data,
    role: 'colaborador',
    capabilities: capabilitiesFor('colaborador'),
    tenant: { id: collaboratorResult.data.tenant_id, [verifiedTenantBrand]: true },
  };
}

/**
 * Resolve a request into an actor and tenant using only a verified bearer session.
 *
 * During P0 containment, membership comes from server-controlled app metadata.
 * Ticket 24 can replace this adapter with persisted organization memberships
 * without changing this public authorization seam.
 */
export async function resolveActorContext(
  request: Request,
  requiredCapability: ActorCapability,
  authUserLookup: AuthUserLookup = defaultAuthUserLookup,
): Promise<ActorContextResult> {
  const identity = await resolveAuthenticatedIdentity(request, authUserLookup);
  if (identity._tag !== 'IdentityVerified') return identity;

  try {
    const membership = resolveLegacyMembership(identity.user);
    if (!membership) {
      return { _tag: 'MembershipMissing' };
    }

    if (!membership.capabilities.has(requiredCapability)) {
      return { _tag: 'CapabilityDenied', capability: requiredCapability };
    }

    return {
      _tag: 'ActorContextResolved',
      context: { ...membership, user: identity.user },
    };
  } catch {
    return { _tag: 'SessionInvalid' };
  }
}

/** Map a typed actor-context denial to its safe HTTP authorization status. */
export function actorContextDenialStatus(denial: ActorContextDenial): 401 | 403 | 503 {
  if (denial._tag === 'IdentityProviderUnavailable') return 503;
  return denial._tag === 'SessionMissing' || denial._tag === 'SessionInvalid'
    ? 401
    : 403;
}

/**
 * Resolve a privileged tenant from an HMAC signature and server-owned mappings.
 *
 * Candidate mappings must come from server-side configuration, and each one
 * carries the secret already in clear text. Decryption is deliberately NOT done
 * here: the credential now lives in the vault (`credenciais_integracao`), and
 * only the vault knows how to open it. Ticket 11 — while this function decrypted
 * its own candidates, its single caller (the Bling webhook) kept reading the
 * aposentada `integracoes_bling`, which has been empty since ticket 10b. Every
 * legitimate event got 403. Taking the secret in clear text forces the caller to
 * name where the credential came from.
 */
export function authorizeSignedServiceTenant(
  rawBody: string,
  signature: string,
  candidates: readonly SignedTenantCandidate[],
): ServiceTenantAuthorizationResult {
  const signatureBuffer = Buffer.from(signature);

  for (const untrustedCandidate of candidates) {
    const candidateResult = signedTenantCandidateSchema.safeParse(untrustedCandidate);
    if (!candidateResult.success) continue;

    const secret = candidateResult.data.secret;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
    const expectedBuffer = Buffer.from(expected);
    if (
      expectedBuffer.length === signatureBuffer.length
      && timingSafeEqual(expectedBuffer, signatureBuffer)
    ) {
      return {
        _tag: 'ServiceTenantAuthorized',
        tenant: { id: candidateResult.data.tenantId, [verifiedTenantBrand]: true },
      };
    }
  }

  return { _tag: 'ServiceTenantDenied' };
}

/**
 * Verify the default application-access capability for legacy route callers.
 * New routes should consume `resolveActorContext` to preserve typed denials.
 */
export async function verifySessionAndRole(
  request: Request,
  authUserLookup: AuthUserLookup = defaultAuthUserLookup,
): Promise<AuthSession | null> {
  const result = await resolveActorContext(request, 'app:access', authUserLookup);
  return result._tag === 'ActorContextResolved' ? result.context : null;
}
