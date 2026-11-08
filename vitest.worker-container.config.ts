import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Só a prova do MSG-020A, disparada por `npm run test:worker` com a imagem
 * construída e o laboratório de pé. Fora do `npm test`: exige Docker.
 */
export default defineConfig({
  test: {
    include: ['src/services/worker/workerContainer.integracao.test.ts', 'scripts/restore-check.integracao.test.ts'],
    testTimeout: 180_000,
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
