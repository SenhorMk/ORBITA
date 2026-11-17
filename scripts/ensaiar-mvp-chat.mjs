import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const saida = resolve(process.argv[2] ?? 'test-results/mvp-chat-local');
mkdirSync(saida, { recursive: true });
await expect.poll(async () => {
  try { return (await fetch('http://127.0.0.1:55830/api/liveness', { signal: AbortSignal.timeout(6000) })).ok; }
  catch { return false; }
}, { timeout: 90000, intervals: [1000, 2000] }).toBe(true);

const browser = await chromium.launch({ channel: process.env.ORBITA_DEMO_BROWSER ?? 'msedge' });
try {
  const contexto = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await contexto.route('**/*', (rota) => new URL(rota.request().url()).hostname === '127.0.0.1'
    ? rota.continue() : rota.abort());
  const operador = await contexto.newPage();
  const cliente = await contexto.newPage();
  await operador.goto('http://127.0.0.1:55830/', { timeout: 90000 });
  await operador.locator('#email-input').fill('atendente@orbita.test');
  await operador.locator('#password-input').fill('Orbita-Demo-2026!');
  const dashboard = operador.waitForResponse(r => r.url().endsWith('/api/dashboard') && r.ok(), { timeout: 60000 });
  await operador.locator('#btn-login-submit').click();
  const sac = operador.getByRole('button', { name: 'SAC / Atendimento', exact: true });
  await expect(sac).toBeVisible({ timeout: 60000 });
  await expect(operador.locator('[title="Organização ativa: ORBITA Demo"], [aria-label^="Organização ativa: ORBITA Demo"]').first())
    .toBeVisible({ timeout: 30000 });
  const offline = operador.getByRole('button', { name: 'Ignorar (Modo Offline)' });
  await offline.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  if (await offline.isVisible()) await offline.click();
  const auth = (await (await dashboard).request().allHeaders()).authorization;
  console.log('Login real via GoTrue e organização ORBITA Demo ativa.');

  await cliente.goto('http://127.0.0.1:55831/');
  async function mensagem(texto) {
    await cliente.getByLabel('Mensagem do cliente').fill(texto);
    await cliente.getByRole('button', { name: 'Enviar mensagem' }).click();
    await expect(cliente.getByRole('status')).toContainText('Webhook aceitou', { timeout: 30000 });
  }

  const rodada = new Date().toISOString().slice(11, 19);
  const primeira = 'Preciso acompanhar meu pedido sintético. ' + rodada;
  await mensagem(primeira);
  await expect.poll(async () => {
    const r = await contexto.request.get('http://127.0.0.1:55830/api/sac/casos', { headers: { authorization: auth } });
    return r.ok() && (await r.json()).eventos[0]?.estado === 'processada';
  }, { timeout: 30000 }).toBe(true);
  await cliente.screenshot({ path: resolve(saida, '01-webhook-sintetico.png') });
  await sac.click({ timeout: 45000 });

  const abrir = operador.getByRole('button', { name: /Cliente Sintético/u });
  await expect(abrir).toBeVisible({ timeout: 45000 });
  await abrir.click();
  await expect(operador.getByText(primeira, { exact: true })).toBeVisible({ timeout: 30000 });
  const gerar = operador.getByRole('button', { name: 'Gerar rascunho de resposta' });
  const painel = operador.getByRole('region', { name: 'Resposta sugerida' });
  async function rascunho() {
    await expect(async () => {
      await gerar.click();
      await expect(painel.getByText('Modelo de demonstração. Revise antes de enviar.')).toBeVisible({ timeout: 3500 });
    }).toPass({ timeout: 45000, intervals: [1000, 2000] });
  }
  await rascunho();
  await operador.screenshot({ path: resolve(saida, '02-cockpit-rascunho.png') });
  await painel.getByRole('button', { name: 'Usar no compositor' }).click();
  const compositor = operador.getByRole('textbox', { name: 'Mensagem', exact: true });
  await expect(compositor).not.toHaveValue('');
  const revisada = 'Olá! Vou ajudar com o seu pedido de demonstração. ' + rodada;
  await compositor.fill(revisada);
  const registro = operador.waitForResponse(r => r.url().endsWith('/api/chatwoot/send') && r.request().method() === 'POST');
  await operador.getByRole('button', { name: 'Enviar', exact: true }).click();
  const respostaEnvio = await registro;
  assert.equal(respostaEnvio.status(), 202);
  const pedido = respostaEnvio.request().postDataJSON();
  const headers = await respostaEnvio.request().allHeaders();
  const listar = async (commandId) => {
    const r = await contexto.request.get('http://127.0.0.1:55830/api/chatwoot/send?conversaId=' + pedido.conversaId, {
      headers: { authorization: headers.authorization },
    });
    if (!r.ok()) return null;
    return (await r.json()).envios.find(e => e.commandId === commandId);
  };
  await expect.poll(async () => (await listar(pedido.commandId))?.estado, { timeout: 30000 }).toBe('enviado');
  assert.ok((await listar(pedido.commandId)).mensagemIdLocal);
  await expect(operador.getByRole('article').filter({ hasText: revisada }).getByText('Você', { exact: true }))
    .toBeVisible({ timeout: 30000 });
  await expect(operador.getByText(revisada, { exact: true })).toHaveCount(1, { timeout: 30000 });
  await expect(operador.getByText('Com você', { exact: true })).toBeVisible({ timeout: 30000 });
  console.log('Rascunho real no cockpit, edição humana e registro HTTP 202; conversa em atendimento humano.');

  const maisUma = 'O código do pedido sintético é DEMO-24. ' + rodada;
  await mensagem(maisUma);
  const segunda = operador.getByText(maisUma, { exact: true });
  await expect(async () => {
    if (!await segunda.isVisible()) {
      await operador.getByRole('button', { name: 'Visão Geral', exact: true }).click();
      await sac.click();
      await abrir.click();
    }
    await expect(segunda).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 35000 });
  assert.equal(await operador.getByText(primeira, { exact: true }).evaluate((anterior, textoNovo) => {
    const novo = Array.from(document.querySelectorAll('p')).find((p) => p.textContent === textoNovo);
    return novo ? Boolean(anterior.compareDocumentPosition(novo) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
  }, maisUma), true);
  await rascunho();
  await operador.screenshot({ path: resolve(saida, '03-historico-contexto-atualizado.png') });
  console.log('Nova mensagem no histórico e novo rascunho.');

  await cliente.getByRole('button', { name: 'Simular falha no próximo recibo' }).click();
  await expect(cliente.getByRole('status')).toContainText('Próximo recibo simulado indisponível');
  await painel.getByRole('button', { name: 'Usar no compositor' }).click();
  const falha = operador.waitForResponse(r => r.url().endsWith('/api/chatwoot/send') && r.request().method() === 'POST');
  await operador.getByRole('button', { name: 'Enviar', exact: true }).click();
  const segundo = await falha;
  assert.equal(segundo.status(), 202);
  await expect.poll(async () => (await listar(segundo.request().postDataJSON().commandId))?.estado, { timeout: 30000 })
    .toBe('desconhecido');
  await expect(operador.getByText('Entrega não confirmada', { exact: true })).toBeVisible({ timeout: 30000 });
  await operador.screenshot({ path: resolve(saida, '04-recibo-ambiguo.png') });
  console.log('HTTP 503 do canal simulado vira estado desconhecido na API de envio.');
} finally {
  await browser.close();
}
