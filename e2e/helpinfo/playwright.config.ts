import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', fullyParallel: false, workers: 1,
  outputDir: '../../test-results/helpinfo',
  reporter: [['list'], ['html', { outputFolder: '../../playwright-report/helpinfo', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3318', trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --config e2e/helpinfo/vite.config.mts', url: 'http://127.0.0.1:3318', reuseExistingServer: !process.env.CI },
});
