import { test, expect } from '@playwright/test';

import { loadSeedManifest, persona } from '../fixtures/personas';
import { LoginPage } from '../pages/LoginPage';
import { OrganizationApi } from '../pages/OrganizationApi';
import { requirePersonaUserId, type SeedManifest } from '../../src/lib/e2e/syntheticSeedData';

// Matrix: "organização: criação/seleção CAS, convite, papéis e revogação."
//
// There is no organization UI in `src/app/page.tsx` to click through (see
// `e2e/pages/OrganizationApi.ts` for why). Every request below rides the
// real authenticated browser session's cookies via `page.request`, which is
// the actual trust boundary a UI widget would also cross if one existed.

let manifest: SeedManifest;

test.beforeAll(() => {
  manifest = loadSeedManifest();
});

test.describe('organização', () => {
  test('owner cria uma organização e ela aparece na listagem do próprio usuário', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);

    const organizationApi = new OrganizationApi(page.request);
    const slug = `${manifest.prefix}spec-created-org`;
    const createResponse = await organizationApi.createOrganization('ORBITA E2E Spec Org', slug);
    expect(createResponse.ok()).toBe(true);
    const created = (await createResponse.json()) as { id: string };
    expect(created.id).toBeTruthy();

    const listResponse = await organizationApi.listOrganizations();
    expect(listResponse.ok()).toBe(true);
    const listed = (await listResponse.json()) as { organizacoes: Array<{ id: string }> };
    expect(listed.organizacoes.some((org) => org.id === created.id)).toBe(true);
  });

  test('seleção CAS aceita a versão esperada e rejeita uma versão desatualizada (evita corrida silenciosa)', async ({
    page,
  }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);

    const organizationApi = new OrganizationApi(page.request);
    const listResponse = await organizationApi.listOrganizations();
    const listed = (await listResponse.json()) as {
      organizacoes: Array<{ id: string }>;
      selectionVersion: number;
    };
    const targetOrgId = listed.organizacoes[0]?.id;
    expect(targetOrgId).toBeTruthy();

    const staleSwitchResponse = await organizationApi.switchActiveOrganization(
      targetOrgId as string,
      listed.selectionVersion + 999,
    );
    expect(staleSwitchResponse.ok()).toBe(false);

    const validSwitchResponse = await organizationApi.switchActiveOrganization(
      targetOrgId as string,
      listed.selectionVersion,
    );
    expect(validSwitchResponse.ok()).toBe(true);
  });

  test('convite criado pelo owner pode ser aceito e o membro passa a existir na organização', async ({
    page,
    browser,
  }) => {
    const owner = persona(manifest, 'owner-a');
    const member = persona(manifest, 'member-a');

    const ownerLogin = new LoginPage(page);
    await ownerLogin.goto();
    await ownerLogin.loginAndWaitForDashboard(owner.email, owner.password);

    const ownerOrgApi = new OrganizationApi(page.request);
    const ownList = (await (await ownerOrgApi.listOrganizations()).json()) as {
      activeOrg: { organizacao: { id: string } };
    };
    const orgId = ownList.activeOrg.organizacao.id;

    const inviteResponse = await ownerOrgApi.createInvite(orgId, member.email, 'member');
    expect(inviteResponse.ok()).toBe(true);
    const invite = (await inviteResponse.json()) as { token: string };
    expect(invite.token).toBeTruthy();

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    const memberLogin = new LoginPage(memberPage);
    await memberLogin.goto();
    await memberLogin.loginAndWaitForDashboard(member.email, member.password);

    const memberOrgApi = new OrganizationApi(memberPage.request);
    const acceptResponse = await memberOrgApi.acceptInvite(invite.token);
    expect(acceptResponse.ok()).toBe(true);

    await memberContext.close();
  });

  test('revogação de membro impede que o membro revogado continue agindo na organização', async ({
    page,
    browser,
  }) => {
    const owner = persona(manifest, 'owner-a');
    const memberToRevoke = persona(manifest, 'member-a');

    const ownerLogin = new LoginPage(page);
    await ownerLogin.goto();
    await ownerLogin.loginAndWaitForDashboard(owner.email, owner.password);

    const ownerOrgApi = new OrganizationApi(page.request);
    const ownList = (await (await ownerOrgApi.listOrganizations()).json()) as {
      activeOrg: { organizacao: { id: string } };
    };
    const orgId = ownList.activeOrg.organizacao.id;

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    const memberLogin = new LoginPage(memberPage);
    await memberLogin.goto();
    await memberLogin.loginAndWaitForDashboard(memberToRevoke.email, memberToRevoke.password);
    const memberBeforeRevocation = await memberPage.request.get('/api/organizacoes');
    expect(memberBeforeRevocation.ok()).toBe(true);

    const revokeResponse = await ownerOrgApi.revokeMember(orgId, requirePersonaUserId(memberToRevoke));
    expect(revokeResponse.ok()).toBe(true);

    const memberAfterRevocation = await memberPage.request.get('/api/organizacoes');
    const afterBody = (await memberAfterRevocation.json()) as {
      organizacoes: Array<{ id: string }>;
    };
    expect(afterBody.organizacoes.some((org) => org.id === orgId)).toBe(false);

    await memberContext.close();
  });
});
