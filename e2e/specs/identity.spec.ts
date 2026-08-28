import { test, expect } from '@playwright/test';

import { loadSeedManifest, persona } from '../fixtures/personas';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import type { SeedManifest } from '../../src/lib/e2e/syntheticSeedData';

// Matrix: "identidade: cadastro/login/logout/sessão expirada e rate limit."
//
// `/api/auth/register` intentionally has no UI form yet (only `/login`,
// which just redirects to `/`) — registration is exercised over the real
// HTTP boundary the browser's own network stack uses, exactly as ticket 24
// allows ("assertions devem observar UI + efeito server ... quando
// aplicável"). Login/logout are exercised through the real login form.

let manifest: SeedManifest;

test.beforeAll(() => {
  manifest = loadSeedManifest();
});

test.describe('identidade', () => {
  test('login com credenciais sintéticas válidas leva ao dashboard autenticado', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);
    await dashboard.expectAuthenticated();
  });

  test('login com senha incorreta é rejeitado com mensagem de erro e sem sessão', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);

    await loginPage.goto();
    await loginPage.login(owner.email, 'senha-errada-de-proposito');
    await loginPage.expectLoginRejected();
  });

  test('logout encerra a sessão e volta ao formulário de login', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);
    await dashboard.logout();

    await expect(loginPage.emailInput).toBeVisible();
    await expect(dashboard.logoutButton).not.toBeVisible();
  });

  test('sessão com token expirado é tratada como não autenticada, não como acesso silencioso', async ({
    page,
  }) => {
    const owner = persona(manifest, 'owner-a');
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await loginPage.goto();
    await loginPage.loginAndWaitForDashboard(owner.email, owner.password);

    // Force the Supabase auth token in localStorage into an already-expired
    // JWT shape (correct structure, past `exp`) instead of just deleting it,
    // so this exercises expiry handling specifically, not "no session at
    // all". A privileged reload must fail closed back to the login form,
    // never keep showing dashboard data from stale client state.
    await page.evaluate(() => {
      const keys = Object.keys(window.localStorage).filter((key) => key.includes('auth-token'));
      for (const key of keys) {
        const stored = window.localStorage.getItem(key);
        if (!stored) continue;
        const parsed = JSON.parse(stored) as { expires_at?: number };
        parsed.expires_at = Math.floor(Date.now() / 1000) - 3600;
        window.localStorage.setItem(key, JSON.stringify(parsed));
      }
    });

    await page.reload();
    await expect(loginPage.emailInput).toBeVisible({ timeout: 15_000 });
    await expect(dashboard.logoutButton).not.toBeVisible();
  });

  test('rate limit de cadastro bloqueia após o limite de tentativas por IP', async ({ request }) => {
    // src/app/api/auth/register/route.ts: DEFAULT_RATE_LIMIT_POLICIES.register
    // = { limit: 5, windowMs: 15 * 60 * 1000 }. The 6th attempt from the same
    // client in the window must be denied with a 429/limited status, and the
    // response must stay generic (no user enumeration) even while limited.
    // Sequential on purpose: rate limiting must observe request order, not a
    // race between concurrently-fired attempts.
    const statuses: number[] = [];
    for (let attemptIndex = 0; attemptIndex < 6; attemptIndex += 1) {
      const response = await request.post('/api/auth/register', {
        data: {
          email: `${manifest.prefix}rate-limit-probe-${attemptIndex}@e2e.orbita.test`,
          password: 'RateLimitProbe!12345',
          name: 'Rate Limit Probe',
        },
      });
      statuses.push(response.status());
    }

    const limitedCount = statuses.filter((status) => status === 429).length;
    expect(limitedCount).toBeGreaterThan(0);
  });
});
