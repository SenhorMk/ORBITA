import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  verifyOrganizationScope,
  type VerifiedOrganizationScope,
} from './verifiedOrganizationScope';

function membershipClient(result: { data: unknown; error: unknown }): SupabaseClient {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const secondEq = vi.fn().mockReturnValue({ maybeSingle });
  const firstEq = vi.fn().mockReturnValue({ eq: secondEq });
  const select = vi.fn().mockReturnValue({ eq: firstEq });
  return { from: vi.fn().mockReturnValue({ select }) } as unknown as SupabaseClient;
}

describe('verifyOrganizationScope', () => {
  it('returns a branded scope only for the exact persisted membership', async () => {
    const result = await verifyOrganizationScope(
      membershipClient({ data: { papel: 'owner' }, error: null }),
      {
        organizationId: '10000000-0000-4000-8000-000000000001',
        actorId: '10000000-0000-4000-8000-000000000002',
      },
    );

    expect(result._tag).toBe('OrganizationScopeVerified');
    if (result._tag === 'OrganizationScopeVerified') {
      expectTypeOf(result.scope).toEqualTypeOf<VerifiedOrganizationScope>();
      expect(result.scope.role).toBe('owner');
    }
  });

  it('fails closed for a missing membership or malformed candidate', async () => {
    const client = membershipClient({ data: null, error: null });
    await expect(verifyOrganizationScope(client, {
      organizationId: '10000000-0000-4000-8000-000000000001',
      actorId: '10000000-0000-4000-8000-000000000003',
    })).resolves.toEqual({ _tag: 'OrganizationScopeDenied' });
    await expect(verifyOrganizationScope(client, {
      organizationId: 'client-controlled',
      actorId: 'also-client-controlled',
    })).resolves.toEqual({ _tag: 'OrganizationScopeDenied' });
  });

  it('distinguishes authorization-store failure from a denied membership', async () => {
    const result = await verifyOrganizationScope(
      membershipClient({ data: null, error: { message: 'connection unavailable' } }),
      {
        organizationId: '10000000-0000-4000-8000-000000000001',
        actorId: '10000000-0000-4000-8000-000000000002',
      },
    );

    expect(result).toEqual({
      _tag: 'OrganizationScopeStoreUnavailable',
      cause: 'connection unavailable',
    });
  });
});
