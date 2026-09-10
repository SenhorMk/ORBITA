import { test, expect } from '@playwright/test';

import { loadSeedManifest, persona } from '../fixtures/personas';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import type { SeedManifest } from '../../src/lib/e2e/syntheticSeedData';

// Matrix: "acessibilidade: teclado, ordem de foco, labels/nome acessível,
// erro e loading nas jornadas críticas."
//
// Scope is the two journeys with real UI: login and the authenticated
// dashboard shell. Assertions use Playwright's built-in accessible-name
// resolution (`getByRole`/`getByLabel`), which fails the same way a screen
// reader user would fail, rather than only checking pixel/DOM presence.

let manifest: SeedManifest;

test.beforeAll(() => {
  manifest = loadSeedManifest();
});

test.describe('acessibilidade', () => {
  test('formulário de login é totalmente operável via teclado, sem uso de mouse', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await loginPage.goto();
    await loginPage.loginViaKeyboardOnly(owner.email, owner.password);
    await dashboard.expectAuthenticated();
  });

  test('campos de login têm rótulos/nome acessível associados (não dependem só de placeholder)', async ({
    page,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Ticket 09 — os rótulos são "E-mail" e "Senha". Eram "E-mail / Usuário Dev"
    // e "Senha Credencial": a tela de entrada anunciava um atalho interno de
    // desenvolvimento no rótulo de um campo público. O atalho continua
    // existindo em `handleLogin`; o que saiu foi o anúncio.
    await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Senha', { exact: true })).toBeVisible();
  });

  test('tentativa de login inválida expõe o erro em um elemento acessível, não só por cor', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);

    await loginPage.goto();
    await loginPage.login(owner.email, 'senha-errada-de-proposito');

    // The error banner in `src/app/page.tsx` renders as visible text content
    // (not only a red border/background), so it is reachable by accessible
    // name/text — assert that, not just "some red element appeared".
    await expect(loginPage.authError).toBeVisible();
  });

  test('botão de login mostra estado de carregamento acessível durante a submissão', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);

    await loginPage.goto();
    await loginPage.emailInput.fill(owner.email);
    await loginPage.passwordInput.fill(owner.password);

    const submitClick = loginPage.submitButton.click();
    await expect(loginPage.submitButton).toBeDisabled();
    await submitClick;
  });

  test('ordem de tabulação da barra de abas do dashboard segue a ordem visual', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);

    await dashboard.salesTab.focus();
    await expect(dashboard.salesTab).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dashboard.inventoryTab).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dashboard.contactsTab).toBeFocused();
  });
});
