import { test, expect } from '@playwright/test';

import { loadSeedManifest, persona } from '../fixtures/personas';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { OrganizationApi } from '../pages/OrganizationApi';
import { CrossTenantProbe } from '../pages/CrossTenantProbe';
import type { SeedManifest } from '../../src/lib/e2e/syntheticSeedData';

// Matrix: "negações: A tenta IDs da B por UI e chamadas HTTP, member tenta
// ação admin, revogado repete sessão."
//
// Every assertion here is a negative: a 200 with another tenant's data, or a
// UI element that renders org-B content while logged in as org-A, is a
// failing test. `organizacao_id` supplied by the client is never authority
// per AGENTS.md — these specs are what proves that server-side, not just by
// reading the code.

let manifest: SeedManifest;
let foreignOrgId: string;

test.beforeAll(async ({ browser }) => {
  manifest = loadSeedManifest();

  // Resolve org B's real id once via its own owner session, so the org-A
  // probes below target a real (but foreign) id rather than a guess.
  const ownerB = persona(manifest, 'owner-b');
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.loginAndWaitForDashboard(ownerB.email, ownerB.password);
  const orgApi = new OrganizationApi(page.request);
  const listResponse = await orgApi.listOrganizations();
  const listed = (await listResponse.json()) as { activeOrg: { organizacao: { id: string } } };
  foreignOrgId = listed.activeOrg.organizacao.id;
  await context.close();
});

test.describe('negações cross-tenant', () => {
  test('org A não consegue trocar (CAS) para a organização B via HTTP', async ({ page }) => {
    const memberA = persona(manifest, 'member-a');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(memberA.email, memberA.password);

    const probe = new CrossTenantProbe(page.request);
    const response = await probe.attemptSwitchToForeignOrganization(foreignOrgId, 0);
    expect(response.ok()).toBe(false);
    expect([401, 403, 404]).toContain(response.status());
  });

  test('org A não consegue listar convites da organização B via HTTP', async ({ page }) => {
    const ownerA = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(ownerA.email, ownerA.password);

    const probe = new CrossTenantProbe(page.request);
    const response = await probe.attemptListForeignInvites(foreignOrgId);
    expect(response.ok()).toBe(false);
    expect([401, 403, 404]).toContain(response.status());
  });

  test('org A não consegue convidar membros para a organização B via HTTP', async ({ page }) => {
    const ownerA = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(ownerA.email, ownerA.password);

    const probe = new CrossTenantProbe(page.request);
    const response = await probe.attemptInviteIntoForeignOrganization(
      foreignOrgId,
      `${manifest.prefix}should-never-exist@e2e.orbita.test`,
    );
    expect(response.ok()).toBe(false);
    expect([401, 403, 404]).toContain(response.status());
  });

  test('membro (role member) não consegue criar convite — ação restrita a admin/owner', async ({ page }) => {
    const memberA = persona(manifest, 'member-a');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(memberA.email, memberA.password);

    const orgApi = new OrganizationApi(page.request);
    const ownList = (await (await orgApi.listOrganizations()).json()) as {
      activeOrg: { organizacao: { id: string } };
    };

    const probe = new CrossTenantProbe(page.request);
    const response = await probe.attemptMemberOnlyInvite(
      ownList.activeOrg.organizacao.id,
      `${manifest.prefix}member-attempted-invite@e2e.orbita.test`,
    );
    expect(response.ok()).toBe(false);
    expect(response.status()).toBe(403);
  });

  test('usuário externo (sem vínculo com A ou B) não enxerga nenhuma organização via API', async ({ page }) => {
    const external = persona(manifest, 'external');
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);
    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(external.email, external.password);
    await dashboard.expectAuthenticated();

    const orgApi = new OrganizationApi(page.request);
    const response = await orgApi.listOrganizations();
    const body = (await response.json()) as { organizacoes: Array<{ id: string }> };
    expect(body.organizacoes.some((org) => org.id === foreignOrgId)).toBe(false);
    expect(body.organizacoes).toHaveLength(0);
  });
});
