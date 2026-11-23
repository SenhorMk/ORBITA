import { test, expect } from '@playwright/test';

const screens = ['finance', 'dashboard', 'sales', 'inventory', 'integrations', 'organization'];
const sizes = [[390, 844], [768, 1024], [1366, 768]];
const versions = ['', '157'];
for (const future of versions) for (const [width, height] of sizes) {
  if (future && width !== 390) continue;
  for (const theme of ['light', 'dark']) for (const screen of screens) {
    test(`${screen} ${width}x${height} ${theme}${future ? ' CSS #157' : ''}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', message => { if (/width\(0\)|height\(0\)/.test(message.text())) errors.push(message.text()); });
      page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      await page.setViewportSize({ width, height });
      await page.goto(`/?tela=${screen}&theme=${theme}&future=${future}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (screen === 'finance') await expect(page.getByText('10 de 12 movimentações', { exact: true })).toBeAttached();
      if (screen === 'organization') await expect(page.getByText('Pessoa de inspeção', { exact: true })).toBeAttached();
      if (screen === 'integrations') {
        await expect(page.getByLabel('Client ID do Bling', { exact: true })).toBeAttached();
        await expect(page.getByText('Caso aberto em triagem.', { exact: true })).toBeVisible();
        await expect(page.getByText(/Última verificação OK em/)).toHaveCount(2);
      }
      const main = page.getByRole('main');
      const metrics = await main.evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
      if (width <= 768) {
        expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
        expect(metrics.overflow).toBe('auto');
      }
      const topbar = page.locator('.orbita-conteudo > .orbita-acoes');
      expect(await topbar.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      for (const child of await topbar.locator(':scope > *').all()) {
        const box = await child.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      if (screen === 'finance') {
        await test.info().attach('inicio', { body: await page.screenshot(), contentType: 'image/png' });
        if (theme === 'light') {
          const value = page.locator('main .orbita-numero').first();
          await value.scrollIntoViewIfNeeded();
          const box = (await value.boundingBox())!;
          const foreground = await value.evaluate(el => getComputedStyle(el).color);
          const png = (await page.screenshot()).toString('base64');
          const background = await page.evaluate(async ({ png, x, y }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${png}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            return Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3);
          }, { png, x: Math.floor(box.x + box.width + 4), y: Math.floor(box.y + box.height / 2) });
          const luminance = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
          const a = luminance(foreground.match(/[\d.]+/g)!.slice(0, 3).map(Number));
          const b = luminance(background);
          expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.5);
        }
        const charts = await page.locator('main section').evaluateAll(elements => elements.filter(el => el.querySelector('h3')).map(el => el.getBoundingClientRect().toJSON()));
        expect(charts).toHaveLength(2);
        const table = await page.getByText('10 de 12 movimentações', { exact: true }).evaluate(el => el.parentElement!.parentElement!.getBoundingClientRect().toJSON());
        if (width <= 768) {
          expect(Math.max(...charts.map(r => r.bottom))).toBeLessThanOrEqual(table.top);
          for (const chart of charts) expect(chart.height).toBeGreaterThanOrEqual(230);
        } else {
          expect(Math.max(...charts.map(r => r.right))).toBeLessThanOrEqual(table.left);
        }
        await page.getByRole('heading', { name: 'Entradas e Saídas', exact: true }).scrollIntoViewIfNeeded();
        await test.info().attach('graficos', { body: await page.screenshot(), contentType: 'image/png' });
      }
      await test.info().attach('tela', { body: await page.screenshot(), contentType: 'image/png' });
      await main.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await test.info().attach('fim-da-rolagem', { body: await page.screenshot(), contentType: 'image/png' });
      if (screen === 'finance' && width <= 768) {
        const details = page.getByRole('button', { name: 'Detalhes', exact: true }).first();
        await details.scrollIntoViewIfNeeded();
        const box = (await details.boundingBox())!;
        const mainBox = (await main.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(mainBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(mainBox.x + mainBox.width);
        await test.info().attach('colunas-da-tabela', { body: await page.screenshot(), contentType: 'image/png' });
      }
      const writes = await page.evaluate(() => (window as unknown as { inspecaoResponsiva: { writes: unknown[] } }).inspecaoResponsiva.writes);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test('navegar entre telas do ERP retorna ao início da página', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tela=finance');
  await expect(page.getByText('10 de 12 movimentações', { exact: true })).toBeAttached();
  await page.getByRole('main').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'Organização & Membros', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.getByRole('main').evaluate(el => el.scrollTop)).toBe(0);
});
