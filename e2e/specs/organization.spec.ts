import { test, expect } from '@playwright/test';

import { loadSeedManifest, persona } from '../fixtures/personas';
import { LoginPage } from '../pages/LoginPage';
import { OrganizationApi } from '../pages/OrganizationApi';
import { requirePersonaUserId, slugDaOrganizacaoDaSpec, type SeedManifest } from '../../src/lib/e2e/syntheticSeedData';

// Matrix: "organização: criação/seleção CAS, convite, papéis e revogação."
//
// There is no organization UI in `src/app/page.tsx` to click through (see
// `e2e/pages/OrganizationApi.ts` for why). Every request below goes through
// `OrganizationApi`, which is the suite's single authenticated path — the same
// route handlers, identity verification and RLS-backed repositories a UI click
// would cross.
//
// **The credential is a bearer token, never a cookie.** This comment used to
// say the requests rode "the authenticated browser session's cookies". They do
// carry cookies, and that buys nothing: `readBearerToken` reads the token
// exclusively from the `Authorization` header. Two calls here went out raw on
// that premise and collected a `401` — the spec broke before the revocation it
// exists to test (ticket 24).
//
// A guard in `src/lib/e2e/chamadasAutenticadasNasSpecs.test.ts` fails, with
// file and line, if a spec ever talks to a route through a page's own request
// context again.

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

    const organizationApi = new OrganizationApi(page);
    // Mesmo texto que o plano do seed prevê, vindo da mesma constante: dois
    // literais independentes deixariam o resíduo voltar numa renomeação.
    const slug = slugDaOrganizacaoDaSpec(manifest.prefix);
    const createResponse = await organizationApi.createOrganization('ORBITA E2E Spec Org', slug);
    expect(createResponse.ok()).toBe(true);
    // A rota devolve { organizacao }, nao { id } solto. O spec foi escrito
    // contra um contrato imaginado e nunca chegou a rodar para descobrir.
    const created = (await createResponse.json()) as { organizacao: { id: string } };
    expect(created.organizacao?.id).toBeTruthy();

    const listResponse = await organizationApi.listOrganizations();
    expect(listResponse.ok()).toBe(true);
    const listed = (await listResponse.json()) as { organizacoes: Array<{ id: string }> };
    expect(listed.organizacoes.some((org) => org.id === created.organizacao.id)).toBe(true);
  });

  test('seleção CAS aceita a versão esperada e rejeita uma versão desatualizada (evita corrida silenciosa)', async ({
    page,
  }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);

    const organizationApi = new OrganizationApi(page);
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

    const ownerOrgApi = new OrganizationApi(page);
    const ownList = (await (await ownerOrgApi.listOrganizations()).json()) as {
      activeOrg: { organizacao: { id: string } };
    };
    const orgId = ownList.activeOrg.organizacao.id;

    const inviteResponse = await ownerOrgApi.createInvite(orgId, member.email, 'member');
    expect(inviteResponse.ok()).toBe(true);
    const invite = (await inviteResponse.json()) as { convite: { token: string } };
    expect(invite.convite.token).toBeTruthy();

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    const memberLogin = new LoginPage(memberPage);
    await memberLogin.goto();
    await memberLogin.loginAndWaitForDashboard(member.email, member.password);

    const memberOrgApi = new OrganizationApi(memberPage);
    const acceptResponse = await memberOrgApi.acceptInvite(invite.convite.token);
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

    const ownerOrgApi = new OrganizationApi(page);
    const ownList = (await (await ownerOrgApi.listOrganizations()).json()) as {
      activeOrg: { organizacao: { id: string } };
    };
    const orgId = ownList.activeOrg.organizacao.id;

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    const memberLogin = new LoginPage(memberPage);
    await memberLogin.goto();
    await memberLogin.loginAndWaitForDashboard(memberToRevoke.email, memberToRevoke.password);
    // Ticket 24 — esta chamada ia crua, sem `Authorization`. A autenticação é
    // por bearer, e `page.request` só compartilha cookie: a rota respondia 401,
    // e a spec quebrava aqui, antes da revogação que ela existe para testar.
    const memberOrgApi = new OrganizationApi(memberPage);
    const memberBeforeRevocation = await memberOrgApi.listOrganizations();
    expect(memberBeforeRevocation.ok()).toBe(true);

    const revokeResponse = await ownerOrgApi.revokeMember(orgId, requirePersonaUserId(memberToRevoke));
    expect(revokeResponse.ok()).toBe(true);

    const memberAfterRevocation = await memberOrgApi.listOrganizations();
    // Sem esta linha, um 401 passaria por prova: o corpo de uma negação também
    // não traz a organização, e a asserção de baixo ficaria verde pelo motivo
    // errado. É o que acontecia antes do ticket 24.
    expect(memberAfterRevocation.ok()).toBe(true);
    const afterBody = (await memberAfterRevocation.json()) as {
      organizacoes: Array<{ id: string }>;
    };
    expect(afterBody.organizacoes.some((org) => org.id === orgId)).toBe(false);

    await memberContext.close();
  });
});
