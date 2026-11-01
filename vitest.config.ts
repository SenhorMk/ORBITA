import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    testTimeout: 15000,
    // `e2e/**` holds real Playwright specs (ticket 24), which use
    // `@playwright/test`'s own `test`/`expect`, not Vitest's. Excluding the
    // directory keeps `npm test` from trying to execute `.spec.ts` files
    // that are not Vitest tests. The pure, non-Playwright logic those specs
    // depend on lives under `src/lib/e2e/` instead, and stays covered by
    // Vitest as normal.
    // `*.integracao.test.ts` needs the disposable lab and runs from `npm run test:db`.
    exclude: [...configDefaults.exclude, 'e2e/**', '**/*.integracao.test.ts'],
    // Component tests (RTL) opt into `jsdom` per-file via the
    // `@vitest-environment jsdom` pragma; API/service/domain tests keep the
    // default `node` environment untouched.
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
