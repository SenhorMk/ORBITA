import type { Page, APIResponse } from '@playwright/test';

import { cabecalhosAutenticados } from './sessaoAutenticada';

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
 * authenticated browser session itself, replayed through `page.request` — the
 * actual browser's network stack, not a Vitest mock. It exercises the same
 * route handlers, the same identity verification
 * (`resolveAuthenticatedIdentity`) and the same RLS-backed repositories a UI
 * click would.
 *
 * **The credential is a bearer token in the `Authorization` header, never a
 * cookie.** This comment used to say the opposite — that `page.request` carries
 * the session because it shares cookies with its `Page`. It does share cookies,
 * and that buys nothing: `readBearerToken` reads the token exclusively from the
 * `Authorization` header and never looks at a cookie. The comment was written
 * before the suite had ever run, and it is what made two calls in
 * `organization.spec.ts` go out raw and collect a `401` (ticket 24).
 *
 * So every method here builds its headers with `cabecalhosAutenticados`, which
 * reads the token from where `supabase-js` keeps it in the browser. **Specs must
 * not call `page.request` directly** — a guard in
 * `src/lib/e2e/chamadasAutenticadasNasSpecs.test.ts` fails, with file and line,
 * if one does.
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
  constructor(private readonly page: Page) {}

  async createOrganization(nome: string, slug: string): Promise<APIResponse> {
    return this.page.request.post('/api/organizacoes', {
      headers: await cabecalhosAutenticados(this.page),
      data: { nome, slug } });
  }

  async listOrganizations(): Promise<APIResponse> {
    return this.page.request.get('/api/organizacoes', { headers: await cabecalhosAutenticados(this.page) });
  }

  async switchActiveOrganization(organizacaoId: string, expectedVersion: number): Promise<APIResponse> {
    return this.page.request.post('/api/organizacoes/switch', {
      headers: await cabecalhosAutenticados(this.page),
      data: { organizacao_id: organizacaoId, expected_version: expectedVersion },
    });
  }

  async createInvite(organizacaoId: string, email: string, papel: 'admin' | 'member'): Promise<APIResponse> {
    return this.page.request.post(`/api/organizacoes/${organizacaoId}/convites`, {
      headers: await cabecalhosAutenticados(this.page),
      data: { email, papel },
    });
  }

  async listInvites(organizacaoId: string): Promise<APIResponse> {
    return this.page.request.get(`/api/organizacoes/${organizacaoId}/convites`, { headers: await cabecalhosAutenticados(this.page) });
  }

  async acceptInvite(token: string): Promise<APIResponse> {
    return this.page.request.post('/api/convites/aceitar', {
      headers: await cabecalhosAutenticados(this.page),
      data: { token } });
  }

  async revokeMember(organizacaoId: string, userId: string): Promise<APIResponse> {
    return this.page.request.delete(`/api/organizacoes/${organizacaoId}/membros/${userId}`, { headers: await cabecalhosAutenticados(this.page) });
  }
}
