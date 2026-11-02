import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Só a prova do MSG-001, disparada por `npm run test:chatwoot` com o Chatwoot real
 * e o laboratório de pé. Fora do `npm test` e do CI: exige Docker e leva minutos.
 */
export default defineConfig({
  test: {
    include: ['src/services/chatwoot/chatwootReal.integracao.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
