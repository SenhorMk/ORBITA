import { describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from './auth';
import {
  activeOrganizationSelection,
  parseOrganizationId,
  resolveOrganizationContext,
  type MembershipLookupResult,
  type OrganizationActorId,
  type OrganizationId,
  type OrganizationMembershipPort,
} from './organizationAuthorization';

const ACTOR_UUID = '10000000-0000-4000-8000-000000000001';
function testOrganizationId(): OrganizationId {
  const result = parseOrganizationId('20000000-0000-4000-8000-000000000001');
  if (!result) throw new Error('Test UUID fixture must be valid.');
  return result;
}
const ORG_ID = testOrganizationId();

const user: AuthenticatedUser = {
  id: ACTOR_UUID,
  app_metadata: { role: 'dono', tenant_id: 'untrusted-legacy-claim' },
};

class FixedMemberships implements OrganizationMembershipPort {
  constructor(private readonly result: MembershipLookupResult) {}

  async findMembership(): Promise<MembershipLookupResult> {
    return this.result;
  }

  async switchActiveOrganization() { return { _tag: 'OrganizationSwitchDenied' } as const; }
}

class RevocableMemberships implements OrganizationMembershipPort {
  private revoked = false;

  revoke(): void {
    this.revoked = true;
  }

  async findMembership(): Promise<MembershipLookupResult> {
    return this.revoked ? { _tag: 'MembershipNotFound' } : found('member');
  }

  async switchActiveOrganization() { return { _tag: 'OrganizationSwitchDenied' } as const; }
}

function found(role: 'owner' | 'admin' | 'member'): MembershipLookupResult {
  return {
    _tag: 'MembershipFound',
    membership: {
      // SAFETY: this UUID literal was independently validated by the application parser in the request flow exercised below.
      actorId: ACTOR_UUID as OrganizationActorId,
      organizationId: ORG_ID,
      role,
      organization: {
        id: ORG_ID,
        nome: 'Organização teste',
        slug: 'organizacao-teste',
        created_at: '2026-08-24T00:00:00.000Z',
        updated_at: '2026-08-24T00:00:00.000Z',
      },
      selectionVersion: 0,
    },
  };
}

const request = new Request('https://orbita.test/api', {
  headers: { authorization: 'Bearer verified', cookie: `orbita_active_org=${ORG_ID}` },
});

describe('canonical organization authorization', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['member', false],
  ] as const)('derives %s capabilities only from persisted membership', async (role, canManage) => {
    const result = await resolveOrganizationContext(request, activeOrganizationSelection(), {
      verifyIdentity: async () => ({ _tag: 'IdentityVerified', user }),
      memberships: new FixedMemberships(found(role)),
    });
    expect(result._tag).toBe('OrganizationContextResolved');
    if (result._tag === 'OrganizationContextResolved') {
      expect(result.context.organizationId).toBe(ORG_ID);
      expect(result.context.capabilities.has('organization:manage')).toBe(canManage);
    }
  });

  it.each(['external user', 'revoked membership'])('denies %s identically', async () => {
    await expect(resolveOrganizationContext(request, activeOrganizationSelection(), {
      verifyIdentity: async () => ({ _tag: 'IdentityVerified', user }),
      memberships: new FixedMemberships({ _tag: 'MembershipNotFound' }),
    })).resolves.toEqual({ _tag: 'OrganizationAccessDenied' });
  });

  it('removes access on the first request after persisted membership revocation', async () => {
    const memberships = new RevocableMemberships();
    const dependencies = {
      verifyIdentity: async () => ({ _tag: 'IdentityVerified' as const, user }),
      memberships,
    };
    await expect(resolveOrganizationContext(request, activeOrganizationSelection(), dependencies))
      .resolves.toMatchObject({ _tag: 'OrganizationContextResolved' });
    memberships.revoke();
    await expect(resolveOrganizationContext(request, activeOrganizationSelection(), dependencies))
      .resolves.toEqual({ _tag: 'OrganizationAccessDenied' });
  });

  it('fails closed for a malformed active cookie', async () => {
    const malformed = new Request('https://orbita.test/api', {
      headers: { cookie: 'orbita_active_org=client-controlled' },
    });
    await expect(resolveOrganizationContext(malformed, activeOrganizationSelection(), {
      verifyIdentity: async () => ({ _tag: 'IdentityVerified', user }),
      memberships: new FixedMemberships(found('owner')),
    })).resolves.toMatchObject({ _tag: 'OrganizationContextResolved' });
  });

  it('distinguishes provider outages from authorization denial', async () => {
    await expect(resolveOrganizationContext(request, activeOrganizationSelection(), {
      verifyIdentity: async () => ({ _tag: 'IdentityProviderUnavailable', cause: 'auth_provider_unreachable' }),
      memberships: new FixedMemberships(found('owner')),
    })).resolves.toEqual({ _tag: 'IdentityProviderUnavailable', cause: 'auth_provider_unreachable' });
    await expect(resolveOrganizationContext(request, activeOrganizationSelection(), {
      verifyIdentity: async () => ({ _tag: 'IdentityVerified', user }),
      memberships: new FixedMemberships({ _tag: 'MembershipStoreUnavailable', cause: 'membership_query_failed' }),
    })).resolves.toEqual({ _tag: 'OrganizationStoreUnavailable', cause: 'membership_query_failed' });
  });
});
