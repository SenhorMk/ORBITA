import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';

test('six synthetic steps on the local rehearsal page', { timeout: 20000 }, async () => {
  const executablePath = process.env.ORBITA_D083_EDGE;
  if (!executablePath) throw Error('Set ORBITA_D083_EDGE to the already installed Edge executable.');
  const origin = 'http://127.0.0.1:55836';
  const child = spawn(process.execPath, [fileURLToPath(new URL('./demo-browser.mjs', import.meta.url))],
    { stdio: ['ignore','pipe','ignore'], windowsHide: true });
  let browser;
  try {
    await Promise.race([
      once(child.stdout,'data'),
      once(child,'exit').then(() => { throw Error('The rehearsal server could not start.'); }),
    ]);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking'] });
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    for (const label of ['Enviar primeira mensagem','Pedir atendente','Assumir pelo ORBITA',
      'Enviar resposta humana','Devolver com resumo','Cliente envia nova mensagem']) {
      await page.getByRole('button', { name: label, exact: true }).click();
    }
    await expect(page.getByRole('button', { name:'Ensaio concluído' })).toBeDisabled();
    await expect(page.getByRole('listitem')).toHaveCount(6);
    await expect(page.getByRole('status')).toHaveText('Responsabilidade: AI · Status remoto simulado: pending');
  } finally {
    await browser?.close();
    child.kill();
  }
});
