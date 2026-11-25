import { test, expect, type Page } from '@playwright/test';

const resolutions = [[390, 844], [768, 1024], [1366, 768], [1920, 1080]];
async function withinViewport(page: Page) {
  const boxes = await page.locator('[role="dialog"]').evaluateAll(elements => elements.map(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, overflow: el.scrollWidth - el.clientWidth };
  }));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    expect(box.overflow).toBeLessThanOrEqual(1);
  }
}
async function capture(page: Page, name: string) {
  await withinViewport(page);
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

for (const [width, height] of resolutions) for (const theme of ['claro', 'escuro']) {
  test(`Financeiro ${width}x${height} ${theme}: grades, rolagem e diálogos aninhados`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width === 390 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: `Tema ${theme}`, exact: true }).click();
    // O resumo nunca pode receber o ícone como uma quarta célula da grade.
    await expect(page.getByText('Total Entradas', { exact: true })).toBeVisible();
    expect(await page.getByText('Total Entradas', { exact: true }).evaluate(el => el.parentElement!.parentElement!.children.length)).toBe(3);
    await page.getByRole('button', { name: 'despesa', exact: true }).click();
    const parent = page.getByRole('dialog', { name: 'Registrar Nova Saída', exact: true });
    const help = parent.locator('[data-help-id="financeiro.despesa"]');
    await expect(help).toBeVisible();
    expect(await help.evaluate(el => Boolean(el.closest('header')))).toBe(true);
    await page.getByLabel('Título', { exact: true }).fill('Rascunho preservado');
    await page.getByLabel('Descrição do Gasto', { exact: true }).fill('Inspeção sem gravação');
    await page.getByLabel('Valor (R$)', { exact: true }).fill('30.50');
    await capture(page, 'nova-despesa-interna');
    const before = await help.boundingBox();
    if (width === 390) await help.tap(); else await help.press('Enter');
    await expect(page.getByRole('dialog', { includeHidden: true })).toHaveCount(2);
    await capture(page, 'ajuda-dentro-da-despesa');
    await page.keyboard.press('Tab');
    expect(await page.getByRole('dialog').last().evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByLabel('Título', { exact: true })).toHaveValue('Rascunho preservado');
    await expect(page.getByLabel('Valor (R$)', { exact: true })).toHaveValue('30.50');
    await expect(help).toBeFocused();
    expect(await help.boundingBox()).toEqual(before);
    expect(before?.width).toBe(28);
    expect(before?.height).toBe(28);
    await page.getByRole('button', { name: 'Lançamento Contábil (Bling)' }).click();
    await page.getByRole('button', { name: 'Cadastrar Novo', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, 'nova-despesa-contabil-rolagem');
    await page.getByRole('button', { name: 'Cadastrar Novo', exact: true }).click();
    await capture(page, 'cadastro-fornecedor');
    await page.locator('[data-help-id="financeiro.fornecedor"]').click();
    await expect(page.getByRole('button', { name: 'Fechar ajuda', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    for (const [screen, action] of [['detalhe', 'Excluir lançamento'], ['cancelamento', 'Cancelar despesa']]) {
      await page.getByRole('button', { name: screen, exact: true }).click();
      await capture(page, screen);
      const pagamento = page.locator('[data-help-id="financeiro.baixa"]');
      expect(await pagamento.evaluate(el => el.parentElement!.textContent)).toContain('Pagamento');
      await page.getByRole('button', { name: action, exact: true }).click();
      await capture(page, `${screen}-confirmacao`);
      await page.locator('[data-help-id="financeiro.correcao"]').click();
      await expect(page.getByRole('button', { name: 'Fechar ajuda', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    }
    expect(errors).toEqual([]);
    await context.close();
  });
}

test('64 ajudas: teclado, Escape, foco e largura em tela pequena', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'galeria', exact: true }).click();
  const triggers = page.locator('[data-help-id]');
  await expect(triggers).toHaveCount(64);
  for (const trigger of await triggers.all()) {
    await trigger.press('Space');
    await expect(page.getByRole('button', { name: 'Fechar ajuda', exact: true })).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await withinViewport(page);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});

for (const width of [390, 768, 1366]) for (const theme of ['claro', 'escuro']) {
  test(`Cabeçalho com indicadores ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : width === 1366 ? 768 : 844 });
    await page.goto('/');
    await page.getByRole('button', { name: `Tema ${theme}`, exact: true }).click();
    await page.getByRole('button', { name: 'Inspecionar painel', exact: true }).click();
    const help = page.locator('[data-help-id="painel.visao"]');
    const header = await help.evaluate(el => {
      const parent = el.parentElement!.parentElement!.parentElement!;
      return { width: parent.clientWidth, scrollWidth: parent.scrollWidth };
    });
    expect(header.scrollWidth).toBeLessThanOrEqual(header.width + 1);
    await test.info().attach('painel', { body: await page.screenshot(), contentType: 'image/png' });
    await help.click();
    await expect(page.getByRole('button', { name: 'Fechar ajuda', exact: true })).toBeFocused();
    await withinViewport(page);
    await page.keyboard.press('Escape');
    await expect(help).toBeFocused();
  });

  test(`Outros modais ${width} ${theme}: produto, contato e venda manual`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : width === 1366 ? 768 : 844 });
    for (const [surface, id] of [['produto', 'estoque.produto'], ['contato', 'clientes.editar'], ['pedido', 'vendas.manual']]) {
      await page.goto('/');
      await page.getByRole('button', { name: `Tema ${theme}`, exact: true }).click();
      await page.getByRole('button', { name: `Inspecionar ${surface}`, exact: true }).click();
      const draft = page.locator(surface === 'produto' ? '#product-detail-nome' : surface === 'contato' ? '#cliente-edit-nome' : '#manual-order-observacoes');
      await draft.fill('Rascunho da inspeção visual');
      if (surface === 'pedido' && theme === 'claro') {
        const colors = await draft.evaluate(el => {
          const style = getComputedStyle(el);
          return { text: style.color, background: style.backgroundColor };
        });
        // O tema claro precisa de texto escuro sobre campo claro, inclusive no legado.
        const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        expect(Math.max(...rgb(colors.text))).toBeLessThan(80);
        expect(Math.min(...rgb(colors.background))).toBeGreaterThan(200);
      }
      await capture(page, surface);
      const help = page.locator(`[data-help-id="${id}"]`);
      expect(await help.evaluate(el => Boolean(el.closest('header')))).toBe(true);
      await help.click();
      // Aguarda a abertura e o autofocus do diálogo antes de enviar Escape.
      await expect(page.getByRole('button', { name: 'Fechar ajuda', exact: true })).toBeFocused();
      await withinViewport(page);
      await page.keyboard.press('Escape');
      await expect(help).toBeFocused();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect(draft).toHaveValue('Rascunho da inspeção visual');
      const lastField = page.getByRole('dialog').locator('input:visible:not(footer input), textarea:visible, select:visible').last();
      await lastField.scrollIntoViewIfNeeded();
      const fieldBox = (await lastField.boundingBox())!;
      const footerBox = (await page.locator('[role="dialog"] footer').boundingBox())!;
      expect(fieldBox.y + fieldBox.height).toBeLessThanOrEqual(footerBox.y + 1);
      if (surface === 'pedido' && width === 390) {
        const choice = await page.locator('[data-help-id="vendas.sincronizar-checkbox"]').evaluate(el => el.parentElement!.getBoundingClientRect().toJSON());
        const cancel = await page.getByRole('button', { name: 'Cancelar', exact: true }).boundingBox();
        expect(choice.bottom).toBeLessThanOrEqual(cancel!.y);
        expect(choice.width).toBeGreaterThan(250);
      }
    }
  });
}
