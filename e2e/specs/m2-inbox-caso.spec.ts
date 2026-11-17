import { expect, test } from '@playwright/test';
import { z } from 'zod';

import { RespostaDaMensageriaSchema } from '../../src/lib/integrations/contratoDaMensageria';
import { loadSeedManifest, organizacao, persona } from '../fixtures/personas';
import { DashboardPage } from '../pages/DashboardPage';
import { LoginPage } from '../pages/LoginPage';
import { consultarCasosSac } from '../pages/SacApi';

const fixtureSchema = z.object({
  eventoId: z.string().uuid(),
  conversaIdLocal: z.string().uuid(),
  marcador: z.string().regex(/^orbita-e2e-[a-z0-9-]{17,}$/),
}).strict();

// A entrega é preparada fora do teste, em uma caixa sintética. Este smoke só lê.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('M2: evento sintético processado abre caso e aparece no histórico do SAC', async ({ page }) => {
  const fixture = process.env.E2E_M2_INBOX_FIXTURE;
  test.skip(!fixture, 'Requer uma entrega sintética já processada e E2E_M2_INBOX_FIXTURE.');
  const { eventoId, conversaIdLocal, marcador } = fixtureSchema.parse(JSON.parse(fixture!));
  const manifest = loadSeedManifest();
  const owner = persona(manifest, 'owner-a');

  const login = new LoginPage(page);
  await login.goto();
  await login.loginAndWaitForDashboard(owner.email, owner.password);
  const dashboard = new DashboardPage(page);
  await dashboard.dispensarCarregadorDeInicializacao();
  expect(await dashboard.nomeDaOrganizacaoAtiva()).toBe(organizacao(manifest, 'org-a').nome);
  const resposta = await consultarCasosSac(page);
  expect(resposta.status()).toBe(200);
  const { eventos, casos } = RespostaDaMensageriaSchema.parse(await resposta.json());
  const evento = eventos.find(({ id }) => id === eventoId);
  expect(evento).toMatchObject({
    tipo: 'message_created',
    estado: 'processada',
    disposicao: 'caso_aberto',
    casoId: expect.any(String),
  });
  expect(casos).toContainEqual(expect.objectContaining({
    id: evento?.casoId,
    conversaIdLocal,
    fase: 'TRIAGE',
  }));

  await dashboard.abrir('sac');
  // O nome do contato é o marcador e a mensagem tem prefixo para distingui-la.
  await page.getByRole('textbox', { name: 'Buscar conversa' }).fill(marcador);
  await page.getByRole('button', { name: new RegExp(marcador) }).click();
  await expect(page.getByText(`Mensagem ${marcador}`, { exact: true })).toBeVisible();
});
