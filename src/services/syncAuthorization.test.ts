import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockVerifyScope, mockAcquireLease, mockReleaseExpiredLeases } = vi.hoisted(() => ({
  mockVerifyScope: vi.fn(),
  mockAcquireLease: vi.fn(),
  mockReleaseExpiredLeases: vi.fn(),
}));

vi.mock('../lib/verifiedOrganizationScope', () => ({
  verifyOrganizationScope: (...args: unknown[]) => mockVerifyScope(...args),
}));

vi.mock('../lib/organizationContext', () => ({
  resolveTenantOrgId: vi.fn().mockResolvedValue('10000000-0000-4000-8000-000000000001'),
}));

vi.mock('../repositories/syncJobRepository', () => ({
  enqueueJob: vi.fn(),
  acquireLease: (...args: unknown[]) => mockAcquireLease(...args),
  advanceCheckpoint: vi.fn(),
  completeJob: vi.fn(),
  getJobStatus: vi.fn(),
  releaseExpiredLeases: (...args: unknown[]) => mockReleaseExpiredLeases(...args),
}));

vi.mock('../lib/supabaseServer', () => ({ supabaseServer: {} }));

import { SyncService } from './sync';

describe('SyncService authorization boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ends pre-lease processing safely when the authorization store is unavailable', async () => {
    mockVerifyScope.mockResolvedValue({
      _tag: 'OrganizationScopeStoreUnavailable',
      cause: 'password authentication failed for postgres',
    });
    const service = new SyncService();

    await expect(service.processJob('job-1', {
      actorId: '10000000-0000-4000-8000-000000000002',
      role: 'dono',
      tenant: { id: '10000000-0000-4000-8000-000000000002' },
    } as never)).resolves.toBeUndefined();

    expect(mockReleaseExpiredLeases).not.toHaveBeenCalled();
    expect(mockAcquireLease).not.toHaveBeenCalled();
  });
});
