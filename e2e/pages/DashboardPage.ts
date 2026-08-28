import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page Object for the authenticated ORBITA shell (`src/app/page.tsx`). The
 * whole app is one client component with tab state (no client-side
 * routing), so "navigating" here means clicking a tab button and asserting
 * its panel becomes visible, not a URL change.
 */
export class DashboardPage {
  readonly page: Page;
  readonly logoutButton: Locator;
  readonly salesTab: Locator;
  readonly inventoryTab: Locator;
  readonly contactsTab: Locator;
  readonly financeTab: Locator;
  readonly sacTab: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logoutButton = page.getByRole('button', { name: 'Sair da sessão' });
    this.salesTab = page.getByRole('button', { name: /Vendas & Pedidos/i });
    this.inventoryTab = page.getByRole('button', { name: /Estoque & Produtos/i });
    this.contactsTab = page.getByRole('button', { name: /Clientes & Contatos/i });
    this.financeTab = page.getByRole('button', { name: /Financeiro/i });
    this.sacTab = page.getByRole('button', { name: /SAC Omnichannel/i });
  }

  async expectAuthenticated(): Promise<void> {
    await expect(this.logoutButton).toBeVisible();
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
  }

  async openSalesTab(): Promise<void> {
    await this.salesTab.click();
  }

  async openInventoryTab(): Promise<void> {
    await this.inventoryTab.click();
  }

  async openContactsTab(): Promise<void> {
    await this.contactsTab.click();
  }

  /** Finds an order row by its human-visible order number in the "Vendas & Pedidos" tab. */
  orderRowByNumber(numero: string): Locator {
    return this.page.getByText(numero, { exact: false }).first();
  }

  /** Locates the NF-e emission control for a given order number, once ORBITA renders it. */
  emitNfeButtonForOrder(numero: string): Locator {
    return this.page
      .locator('[data-pedido-numero], tr, div', { hasText: numero })
      .getByRole('button', { name: /Emitir NF-e/i })
      .first();
  }
}
