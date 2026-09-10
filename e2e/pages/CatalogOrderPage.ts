import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page Object for the "Vendas & Pedidos" tab and its manual-order modal
 * (`src/components/ManualOrderModal.tsx`). Selectors are tied to real DOM:
 * `#manual-order-cliente` (native `<select>`), `#manual-order-buscar-produto`
 * (product search input, results rendered as buttons once the query is
 * longer than one character), and the modal's submit button
 * "Finalizar e baixar estoque".
 *
 * O botão que abre o modal chama-se **"Novo pedido manual"**. Aqui estava
 * escrito "Incluir Pedido Manual", nome que a barra de ações não usa desde o
 * Ticket 01 — o clique nunca encontrava alvo (Ticket 09).
 *
 * `sincronizarComBlingCheckbox` é o controle que decide se existe escrita
 * externa: com ele desligado, `POST /api/pedidos/manual` grava a venda no
 * Orbita e **não** chama o ERP (ver `handler.ts`, `if (body.syncBling)`). É
 * por isso que ele é a fronteira entre a venda controlada, que um teste pode
 * executar, e a escrita real no Bling, que exige autorização nominal.
 */
export class CatalogOrderPage {
  readonly page: Page;
  readonly openManualOrderButton: Locator;
  readonly clienteSelect: Locator;
  readonly produtoSearchInput: Locator;
  readonly submitButton: Locator;
  readonly cancelButton: Locator;
  readonly errorBanner: Locator;
  readonly sincronizarComBlingCheckbox: Locator;

  constructor(page: Page) {
    this.page = page;
    this.openManualOrderButton = page.getByRole('button', { name: 'Novo pedido manual' });
    this.clienteSelect = page.locator('#manual-order-cliente');
    this.produtoSearchInput = page.locator('#manual-order-buscar-produto');
    this.submitButton = page.getByRole('button', { name: 'Finalizar e baixar estoque' });
    this.cancelButton = page.getByRole('button', { name: 'Cancelar' });
    this.errorBanner = page.getByText(/Erro:|Selecione um cliente|Adicione pelo menos um item/);
    this.sincronizarComBlingCheckbox = page.getByRole('checkbox', {
      name: /Sincronizar pedido com o Bling/i,
    });
  }

  async openModal(): Promise<void> {
    await this.openManualOrderButton.click();
    await expect(this.clienteSelect).toBeVisible();
  }

  /**
   * Desliga a escrita externa antes de qualquer envio.
   *
   * O padrão do modal é **ligado**, e é o padrão certo para uma loja: a venda
   * do balcão precisa chegar ao ERP. Um teste não tem essa autorização, então
   * ele desliga — e confere que desligou, porque "achei que tinha desmarcado"
   * é exatamente como um teste vira um pedido de verdade no Bling.
   */
  async desligarEscritaNoBling(): Promise<void> {
    await expect(this.sincronizarComBlingCheckbox).toBeVisible();
    await this.sincronizarComBlingCheckbox.uncheck();
    await expect(this.sincronizarComBlingCheckbox).not.toBeChecked();
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

  /**
   * A linha de um pedido na tabela de "Vendas & Pedidos", pelo nome do cliente.
   *
   * A tabela do Design System (`TabelaDePedidos.tsx`) não usa `<tr>` nem
   * `role="row"` — este seletor procurava uma estrutura que a tela não tem
   * desde o Ticket 02. O que existe, e é estável, é o botão que abre o pedido:
   * o nome do cliente É o nome acessível dele.
   */
  orderRowByClienteName(clienteNome: string): Locator {
    return this.page.getByRole('button', { name: clienteNome }).first();
  }

  emitNfeButton(orderRow: Locator): Locator {
    return orderRow.getByRole('button', { name: /Emitir NF-e/i });
  }
}
