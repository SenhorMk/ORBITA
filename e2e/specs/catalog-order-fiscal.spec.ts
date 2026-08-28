import { test, expect } from '@playwright/test';

import { loadSeedManifest, persona } from '../fixtures/personas';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { CatalogOrderPage } from '../pages/CatalogOrderPage';
import type { SeedManifest } from '../../src/lib/e2e/syntheticSeedData';

// Matrix: "catálogo/comercial: produto→cliente→pedido→estoque→fiscal."
//
// This is one of the few journeys with real UI end-to-end: the "Vendas &
// Pedidos" tab, the manual-order modal (`ManualOrderModal.tsx`), and the
// NF-e emission button all exist as clickable controls in
// `src/app/page.tsx`. Both product and client records for this test must
// already exist in staging from `e2e/seed/run-seed.ts` (products/clients
// come from Bling sync or manual seed rows, not from this spec) — this spec
// only drives the order → stock → fiscal part of the chain.

let manifest: SeedManifest;

test.beforeAll(() => {
  manifest = loadSeedManifest();
});

test.describe('catálogo → pedido → estoque → fiscal', () => {
  test('criar pedido manual debita estoque e o pedido aparece em Vendas & Pedidos', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);
    const catalog = new CatalogOrderPage(page);

    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);
    await dashboard.openSalesTab();

    await catalog.openModal();
    await catalog.selectClienteByLabel(`${manifest.prefix}cliente-catalogo`);
    await catalog.addProdutoByName(`${manifest.prefix}produto-catalogo`);
    await catalog.submitOrder();

    await expect(catalog.errorBanner).not.toBeVisible();
    const orderRow = catalog.orderRowByClienteName(`${manifest.prefix}cliente-catalogo`);
    await expect(orderRow).toBeVisible({ timeout: 15_000 });
  });

  test('pedido criado pode ser faturado e passa a exibir NF-e emitida', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);
    const catalog = new CatalogOrderPage(page);

    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);
    await dashboard.openSalesTab();

    const orderRow = catalog.orderRowByClienteName(`${manifest.prefix}cliente-catalogo`);
    await expect(orderRow).toBeVisible({ timeout: 15_000 });

    const emitButton = catalog.emitNfeButton(orderRow);
    await emitButton.click();

    await expect(orderRow.getByText(/Atendido|NF-e emitida/i)).toBeVisible({ timeout: 20_000 });
  });
});
