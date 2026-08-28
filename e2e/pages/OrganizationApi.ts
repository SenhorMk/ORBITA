import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * Not a UI Page Object — deliberately. `src/app/page.tsx` has no
 * organization-creation screen, no active-organization switcher (CAS), no
 * invite screen, and no member/role management screen (confirmed by
 * grepping for "organiza"/"convite" across the component: the only
 * `DropdownMenuRadioGroup` usages are product sorting/filtering, unrelated
 * to tenancy). There is nothing to click.
 *
 * The real, verifiable trust boundary for the organization matrix
 * (`organização: criação/seleção CAS, convite, papéis e revogação`) is the
 * authenticated browser session itself: the Supabase auth cookie the login
 * spec establishes, replayed through `page.request` (which shares cookies
 * with the `Page` it comes from). That is still the actual browser's
 * network stack, not a Vitest mock — it exercises the same route handlers,
 * session verification (`resolveAuthenticatedIdentity`/
 * `verifySessionAndRole`), and RLS-backed repositories a UI click would.
 *
 * Route shapes mirror the real handlers under `src/app/api/organizacoes/`:
 * - `POST /api/organizacoes` — { nome, slug } -> { id, ... }
 * - `GET /api/organizacoes` — { organizacoes, activeOrg, selectionVersion }
 * - `POST /api/organizacoes/switch` — { organizacao_id, expected_version } (CAS)
 * - `POST /api/organizacoes/:id/convites` — { email, papel } -> { id, token }
 * - `POST /api/convites/aceitar` — { token }
 * - `DELETE /api/organizacoes/:id/membros/:userId` — revoke
 */
export class OrganizationApi {
  constructor(private readonly request: APIRequestContext) {}

  async createOrganization(nome: string, slug: string): Promise<APIResponse> {
    return this.request.post('/api/organizacoes', { data: { nome, slug } });
  }

  async listOrganizations(): Promise<APIResponse> {
    return this.request.get('/api/organizacoes');
  }

  async switchActiveOrganization(organizacaoId: string, expectedVersion: number): Promise<APIResponse> {
    return this.request.post('/api/organizacoes/switch', {
      data: { organizacao_id: organizacaoId, expected_version: expectedVersion },
    });
  }

  async createInvite(organizacaoId: string, email: string, papel: 'admin' | 'member'): Promise<APIResponse> {
    return this.request.post(`/api/organizacoes/${organizacaoId}/convites`, {
      data: { email, papel },
    });
  }

  async listInvites(organizacaoId: string): Promise<APIResponse> {
    return this.request.get(`/api/organizacoes/${organizacaoId}/convites`);
  }

  async acceptInvite(token: string): Promise<APIResponse> {
    return this.request.post('/api/convites/aceitar', { data: { token } });
  }

  async revokeMember(organizacaoId: string, userId: string): Promise<APIResponse> {
    return this.request.delete(`/api/organizacoes/${organizacaoId}/membros/${userId}`);
  }
}
