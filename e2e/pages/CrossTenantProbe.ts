import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * Helper for the cross-tenant denial spec: given an authenticated session
 * belonging to one organization, attempt to read/act on a resource id that
 * belongs to a different organization, over the real HTTP boundary. A
 * passing spec asserts these all fail closed (401/403/404, never 200 with
 * another tenant's data).
 */
export class CrossTenantProbe {
  constructor(private readonly request: APIRequestContext) {}

  /** Attempt to switch the active organization to one the caller is not a member of. */
  async attemptSwitchToForeignOrganization(foreignOrgId: string, expectedVersion: number): Promise<APIResponse> {
    return this.request.post('/api/organizacoes/switch', {
      data: { organizacao_id: foreignOrgId, expected_version: expectedVersion },
    });
  }

  /** Attempt to list invites of an organization the caller does not belong to. */
  async attemptListForeignInvites(foreignOrgId: string): Promise<APIResponse> {
    return this.request.get(`/api/organizacoes/${foreignOrgId}/convites`);
  }

  /** Attempt to invite a member into an organization the caller does not belong to. */
  async attemptInviteIntoForeignOrganization(foreignOrgId: string, email: string): Promise<APIResponse> {
    return this.request.post(`/api/organizacoes/${foreignOrgId}/convites`, {
      data: { email, papel: 'member' },
    });
  }

  /** Attempt to revoke a member of an organization the caller does not belong to. */
  async attemptRevokeForeignMember(foreignOrgId: string, foreignUserId: string): Promise<APIResponse> {
    return this.request.delete(`/api/organizacoes/${foreignOrgId}/membros/${foreignUserId}`);
  }

  /** A `member`-role caller attempting an admin-only action (invite creation). */
  async attemptMemberOnlyInvite(ownOrgId: string, email: string): Promise<APIResponse> {
    return this.request.post(`/api/organizacoes/${ownOrgId}/convites`, {
      data: { email, papel: 'member' },
    });
  }

  /** Any authenticated request replayed after the caller's membership was revoked server-side. */
  async attemptAnyAuthenticatedRequestAfterRevocation(): Promise<APIResponse> {
    return this.request.get('/api/organizacoes');
  }
}
