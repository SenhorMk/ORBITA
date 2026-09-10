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
// `src/app/page.tsx` — and os seletores deste arquivo foram corrigidos no
// Ticket 09, em `e2e/pages/CatalogOrderPage.ts`.
//
// ---------------------------------------------------------------------------
// POR QUE ESTES DOIS CASOS ESTÃO PARADOS — e o que os destrava
// ---------------------------------------------------------------------------
// O cabeçalho original dizia que `${prefix}cliente-catalogo` e
// `${prefix}produto-catalogo` "já existem no staging vindos do seed". Não
// existem, e nunca existiram: `e2e/seed/run-seed.ts` cria usuários,
// organizações e vínculos — e nada comercial (ver `execucaoSeed.ts`, cujos
// únicos tipos de registro são `usuario`, `organizacao` e `membership`).
//
// E o seed não pode simplesmente passar a criá-los: no Orbita, cadastrar
// cliente e produto é `POST /api/clientes/update` e `POST /api/produtos/update`,
// e os dois **escrevem no Bling**. Fabricá-los para o teste seria escrita
// externa real, que exige autorização nominal da proprietária — e as
// organizações sintéticas nem conexão com o ERP têm.
//
// Ficar vermelho por falta de dado não é sinal, é ruído: um vermelho
// permanente treina quem olha a suíte a ignorar vermelho. E fazê-los passar
// contra dado inventado seria pior — provaria uma venda que não aconteceu.
// Então ficam declarados como parados, com a condição exata que os devolve:
// uma organização de teste com cliente e produto próprios, criados por um
// caminho que não passe pelo ERP.
//
// A parte desta jornada que **pode** ser provada sem isso — a venda manual com
// a escrita externa desligada e o envio bloqueado enquanto falta cliente ou
// item — está em `jornada-banca.spec.ts`. A venda executada, com resultado
// visível, é validação operacional na organização de demonstração.
test.describe.configure({ mode: 'serial' });

let manifest: SeedManifest;

test.beforeAll(() => {
  manifest = loadSeedManifest();
});

test.describe('catálogo → pedido → estoque → fiscal', () => {
  test.skip(
    true,
    'Sem dado comercial no seed sintético: o cliente e o produto deste caso só podem ser criados '
      + 'por um caminho que escreve no Bling. Ver o cabeçalho deste arquivo.',
  );

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
