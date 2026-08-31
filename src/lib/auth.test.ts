import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  actorContextDenialStatus,
  authorizeSignedServiceTenant,
  resolveActorContext,
  type AuthenticatedUser,
  type AuthUserLookup,
} from './auth';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const COLLABORATOR_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';

function requestWithToken(): Request {
  return new Request('https://orbita.test/api/dashboard', {
    headers: { Authorization: 'Bearer signed-access-token' },
  });
}

function lookupReturning(user: AuthenticatedUser): AuthUserLookup {
  return {
    getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
  };
}

describe('resolveActorContext', () => {
  it('distinguishes identity-provider unavailability from an invalid session', async () => {
    const result = await resolveActorContext(requestWithToken(), 'app:access', {
      getUser: async () => { throw new Error('network unavailable'); },
    });
    expect(result).toEqual({
      _tag: 'IdentityProviderUnavailable',
      cause: 'auth_provider_unreachable',
    });
    if (result._tag !== 'ActorContextResolved') {
      expect(actorContextDenialStatus(result)).toBe(503);
    }
  });

  it('derives the legacy owner tenant from a verified session', async () => {
    const result = await resolveActorContext(
      requestWithToken(),
      'tenant:manage',
      lookupReturning({ id: OWNER_ID, app_metadata: { role: 'dono' } }),
    );

    expect(result).toMatchObject({
      _tag: 'ActorContextResolved',
      context: {
        actorId: OWNER_ID,
        role: 'dono',
        tenant: { id: OWNER_ID },
      },
    });
  });

  it('uses the server-controlled tenant assigned to a collaborator', async () => {
    const result = await resolveActorContext(
      requestWithToken(),
      'app:access',
      lookupReturning({
        id: COLLABORATOR_ID,
        app_metadata: { role: 'colaborador', tenant_id: TENANT_ID },
      }),
    );

    expect(result).toMatchObject({
      _tag: 'ActorContextResolved',
      context: {
        actorId: COLLABORATOR_ID,
        role: 'colaborador',
        tenant: { id: TENANT_ID },
      },
    });
  });

  it('denies an authenticated external user without a membership', async () => {
    const result = await resolveActorContext(
      requestWithToken(),
      'app:access',
      lookupReturning({ id: COLLABORATOR_ID, app_metadata: {} }),
    );

    expect(result).toEqual({ _tag: 'MembershipMissing' });
    if (result._tag !== 'ActorContextResolved') {
      expect(actorContextDenialStatus(result)).toBe(403);
    }
  });

  it('denies a request without a session before consulting the provider', async () => {
    const authUserLookup: AuthUserLookup = { getUser: vi.fn() };

    const result = await resolveActorContext(
      new Request('https://orbita.test/api/dashboard'),
      'app:access',
      authUserLookup,
    );

    expect(result).toEqual({ _tag: 'SessionMissing' });
    if (result._tag !== 'ActorContextResolved') {
      expect(actorContextDenialStatus(result)).toBe(401);
    }
    expect(authUserLookup.getUser).not.toHaveBeenCalled();
  });

  it('returns a typed denial when the membership lacks the capability', async () => {
    const result = await resolveActorContext(
      requestWithToken(),
      'tenant:manage',
      lookupReturning({
        id: COLLABORATOR_ID,
        app_metadata: { role: 'colaborador', tenant_id: TENANT_ID },
      }),
    );

    expect(result).toEqual({
      _tag: 'CapabilityDenied',
      capability: 'tenant:manage',
    });
  });
});

describe('authorizeSignedServiceTenant', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves a tenant from a server mapping and a valid signature', () => {
    const rawBody = '{"event":"product.updated"}';
    const secret = 'provider-webhook-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

    const result = authorizeSignedServiceTenant(rawBody, signature, [{
      tenantId: TENANT_ID,
      secret,
    }]);

    expect(result).toMatchObject({
      _tag: 'ServiceTenantAuthorized',
      tenant: { id: TENANT_ID },
    });
  });

  it('denies invalid signatures and malformed server mappings', () => {
    expect(authorizeSignedServiceTenant('body', 'sha256=invalid', [{
      tenantId: TENANT_ID,
      secret: 'provider-webhook-secret',
    }])).toEqual({
      _tag: 'ServiceTenantDenied',
    });
    expect(authorizeSignedServiceTenant('body', 'sha256=invalid', [{
      tenantId: 'tenant-from-payload',
      secret: 'provider-webhook-secret',
    }])).toEqual({
      _tag: 'ServiceTenantDenied',
    });
  });
});
