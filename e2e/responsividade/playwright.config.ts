import { defineConfig } from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', fullyParallel: false, workers: 1,
  timeout: 45_000, outputDir: '../../test-results/responsividade',
  reporter: [['list'], ['html', { outputFolder: '../../playwright-report/responsividade', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3319', trace: 'retain-on-failure' },
  webServer: {
    cwd: path.resolve(__dirname, '../..'),
    command: 'node node_modules/vite/bin/vite.js --config e2e/responsividade/vite.config.mts',
    url: 'http://127.0.0.1:3319', reuseExistingServer: !process.env.CI,
  },
});
