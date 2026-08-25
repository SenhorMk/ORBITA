import { z } from 'zod';

import {
  resolveAuthenticatedIdentity,
  type AuthenticatedIdentityResult,
  type AuthenticatedUser,
} from './auth';
import type { Organizacao, PapelMembro } from './organizationContext';

const actorIdSchema = z.string().uuid().brand<'OrganizationActorId'>();
const organizationIdSchema = z.string().uuid().brand<'OrganizationId'>();
const contextBrand: unique symbol = Symbol('CanonicalOrganizationContext');

/** UUID brand for organization actors. */
export type OrganizationActorId = z.infer<typeof actorIdSchema>;

/** UUID brand for organizations. */
export type OrganizationId = z.infer<typeof organizationIdSchema>;

/** Organization selection resolved at the HTTP boundary. */
export type OrganizationSelection =
  | { readonly _tag: 'FirstMembership' }
  | { readonly _tag: 'ExactOrganization'; readonly organizationId: OrganizationId };

/** Persisted membership returned by an authorization adapter. */
export interface PersistedOrganizationMembership {
  readonly actorId: OrganizationActorId;
  readonly organizationId: OrganizationId;
  readonly role: PapelMembro;
  readonly organization: Organizacao;
  readonly selectionVersion: number;
}

/** Typed result of looking up one persisted membership. */
export type MembershipLookupResult =
  | { readonly _tag: 'MembershipFound'; readonly membership: PersistedOrganizationMembership }
  | { readonly _tag: 'MembershipNotFound' }
  | { readonly _tag: 'MembershipStoreUnavailable'; readonly cause: string };

/** Outcome of an atomic persisted active-organization switch. */
export type OrganizationSwitchResult =
  | { readonly _tag: 'OrganizationSwitchApplied'; readonly version: number }
  | { readonly _tag: 'OrganizationSwitchStale' }
  | { readonly _tag: 'OrganizationSwitchDenied' }
  | { readonly _tag: 'MembershipStoreUnavailable'; readonly cause: string };

/** Application-owned capability required from organization persistence. */
export interface OrganizationMembershipPort {
  /** Find the first membership or an exact actor/organization membership. */
  readonly findMembership: (
    actorId: OrganizationActorId,
    selection: OrganizationSelection,
  ) => Promise<MembershipLookupResult>;
  /** Atomically persist an authorized active organization using compare-and-swap. */
  readonly switchActiveOrganization: (
    actorId: OrganizationActorId,
    organizationId: OrganizationId,
    expectedVersion: number,
  ) => Promise<OrganizationSwitchResult>;
}

/** Authorization capability derived from a persisted organization role. */
export type OrganizationCapability = 'organization:access' | 'organization:manage';

/** Canonical actor, organization, role and capabilities proven server-side. */
export interface OrganizationContext {
  readonly actorId: OrganizationActorId;
  readonly user: AuthenticatedUser;
  readonly organizationId: OrganizationId;
  readonly organization: Organizacao;
  readonly role: PapelMembro;
  readonly capabilities: ReadonlySet<OrganizationCapability>;
  readonly selectionVersion: number;
  readonly [contextBrand]: true;
}

/** Tagged outcome of resolving canonical organization authority. */
export type OrganizationContextResult =
  | { readonly _tag: 'OrganizationContextResolved'; readonly context: OrganizationContext }
  | Exclude<AuthenticatedIdentityResult, { readonly _tag: 'IdentityVerified' }>
  | { readonly _tag: 'OrganizationAccessDenied' }
  | { readonly _tag: 'OrganizationStoreUnavailable'; readonly cause: string };

/** Identity and membership dependencies. */
export interface OrganizationAuthorizationDependencies {
  readonly verifyIdentity: (request: Request) => Promise<AuthenticatedIdentityResult>;
  readonly memberships: OrganizationMembershipPort;
}

function capabilitiesForRole(role: PapelMembro): ReadonlySet<OrganizationCapability> {
  return role === 'member'
    ? new Set(['organization:access'])
    : new Set(['organization:access', 'organization:manage']);
}

/** Parse an untrusted organization identifier into the authorization domain. */
export function parseOrganizationId(input: string): OrganizationId | null {
  const result = organizationIdSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** Parse an untrusted actor identifier into the organization authorization domain. */
export function parseOrganizationActorId(input: string): OrganizationActorId | null {
  const result = actorIdSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** Select the persisted active organization; request cookies never carry authority. */
export function activeOrganizationSelection(): OrganizationSelection {
  return { _tag: 'FirstMembership' };
}

/** Resolve verified identity and persisted membership into canonical organization context. */
export async function resolveOrganizationContext(
  request: Request,
  selection: OrganizationSelection | null,
  dependencies: OrganizationAuthorizationDependencies,
): Promise<OrganizationContextResult> {
  if (!selection) return { _tag: 'OrganizationAccessDenied' };
  const identity = await dependencies.verifyIdentity(request);
  if (identity._tag !== 'IdentityVerified') return identity;

  const actorId = actorIdSchema.safeParse(identity.user.id);
  if (!actorId.success) return { _tag: 'OrganizationAccessDenied' };

  const lookup = await dependencies.memberships.findMembership(actorId.data, selection);
  if (lookup._tag === 'MembershipNotFound') return { _tag: 'OrganizationAccessDenied' };
  if (lookup._tag === 'MembershipStoreUnavailable') {
    return { _tag: 'OrganizationStoreUnavailable', cause: lookup.cause };
  }

  const { membership } = lookup;
  return {
    _tag: 'OrganizationContextResolved',
    context: {
      actorId: membership.actorId,
      user: identity.user,
      organizationId: membership.organizationId,
      organization: membership.organization,
      role: membership.role,
      capabilities: capabilitiesForRole(membership.role),
      selectionVersion: membership.selectionVersion,
      [contextBrand]: true,
    },
  };
}

/** Translate a canonical authorization failure into a safe HTTP status. */
export function organizationContextStatus(
  result: Exclude<OrganizationContextResult, { readonly _tag: 'OrganizationContextResolved' }>,
): 401 | 403 | 503 {
  if (result._tag === 'IdentityProviderUnavailable' || result._tag === 'OrganizationStoreUnavailable') return 503;
  if (result._tag === 'SessionMissing' || result._tag === 'SessionInvalid') return 401;
  return 403;
}

/** Verify request identity with the configured provider. */
export const verifyRequestIdentity = resolveAuthenticatedIdentity;
