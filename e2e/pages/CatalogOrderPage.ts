import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page Object for the "Vendas & Pedidos" tab and its manual-order modal
 * (`src/components/ManualOrderModal.tsx`). Selectors are tied to real DOM:
 * `#manual-order-cliente` (native `<select>`), `#manual-order-buscar-produto`
 * (product search input, results rendered as buttons once the query is
 * longer than one character), and the modal's submit button text
 * "Finalizar e Baixar Estoque".
 */
export class CatalogOrderPage {
  readonly page: Page;
  readonly openManualOrderButton: Locator;
  readonly clienteSelect: Locator;
  readonly produtoSearchInput: Locator;
  readonly submitButton: Locator;
  readonly cancelButton: Locator;
  readonly errorBanner: Locator;

  constructor(page: Page) {
    this.page = page;
    this.openManualOrderButton = page.getByRole('button', { name: 'Incluir Pedido Manual' });
    this.clienteSelect = page.locator('#manual-order-cliente');
    this.produtoSearchInput = page.locator('#manual-order-buscar-produto');
    this.submitButton = page.getByRole('button', { name: 'Finalizar e Baixar Estoque' });
    this.cancelButton = page.getByRole('button', { name: 'Cancelar' });
    this.errorBanner = page.getByText(/Erro:|Selecione um cliente|Adicione pelo menos um item/);
  }

  async openModal(): Promise<void> {
    await this.openManualOrderButton.click();
    await expect(this.clienteSelect).toBeVisible();
  }

  async selectClienteByLabel(clienteNome: string): Promise<void> {
    await this.clienteSelect.selectOption({ label: clienteNome });
  }

  async addProdutoByName(produtoNomeOuSku: string): Promise<void> {
    await this.produtoSearchInput.fill(produtoNomeOuSku);
    const resultButton = this.page
      .locator('button', { hasText: produtoNomeOuSku })
      .first();
    await expect(resultButton).toBeVisible();
    await resultButton.click();
  }

  async submitOrder(): Promise<void> {
    await this.submitButton.click();
  }

  /** Locates the order row for a freshly created order by matching client name in "Vendas & Pedidos". */
  orderRowByClienteName(clienteNome: string): Locator {
    return this.page.locator('tr, div[role="row"]', { hasText: clienteNome }).first();
  }

  emitNfeButton(orderRow: Locator): Locator {
    return orderRow.getByRole('button', { name: /Emitir NF-e/i });
  }
}
