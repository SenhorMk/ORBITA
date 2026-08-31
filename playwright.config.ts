import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

import { resolveStagingConfig } from './src/lib/e2e/stagingConfig';

// `.env.local` é o mesmo arquivo que o resto do projeto usa e o git ignora.
// Sem isto, rodar a suíte exigia repetir seis variáveis na linha de comando a
// cada execução — e o jeito mais provável de errar um alvo é digitá-lo de novo
// toda vez. Variáveis já presentes no ambiente continuam vencendo (`override`
// fica desligado), então o CI segue mandando.
dotenv.config({ path: '.env.local', quiet: true });

/**
 * Fail-closed by construction: `resolveStagingConfig` throws
 * `StagingConfigError` (see `src/lib/e2e/stagingConfig.ts` and its Vitest
 * coverage in `stagingConfig.test.ts`) unless `STAGING_URL` is an explicit
 * HTTPS staging URL. When that happens, this module throws too, and
 * Playwright never starts a single test — there is no fallback to
 * localhost, no default target, no way to silently run against the wrong
 * environment.
 *
 * The one intentional exception is static structural validation
 * (`npm run e2e:list`, i.e. `playwright test --list`): that command may be
 * pointed at an RFC 2606 `.invalid` placeholder host, which can never
 * resolve on any network. That proves the suite compiles and loads — it is
 * not, and must never be presented as, evidence of a real staging run.
 */
const stagingConfig = resolveStagingConfig(process.env);

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  // Ticket 24: "rodar cada spec isolada, depois suite serial/paralela
  // conforme isolamento." Default to serial, single-worker execution so a
  // failure is always attributable to one spec's data, not to
  // cross-test interference. Raise workers deliberately once specs are
  // proven independent against real staging data.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Flaky is a bug (ticket 24: "proibido retry mascarando assert") — never
  // paper over an intermittent failure with automatic retries.
  retries: 0,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: stagingConfig.baseURL,
    // Traces/screenshots/video only on failure, per ticket 24's evidence
    // rules; whoever reviews a failure trace must still redact secrets
    // before sharing it, since Playwright does not redact automatically.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
