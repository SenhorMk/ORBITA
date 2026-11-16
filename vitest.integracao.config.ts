import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Só as provas integradas do MSG-006 e do MSG-013, disparadas por
 * `scripts/database-integracao-consumidor-inbox.mjs` com o laboratório de pé.
 * O `npm test` não a alcança: `vitest.config.ts` exclui `*.integracao.test.ts`.
 */
export default defineConfig({
  test: {
    include: ['src/services/chatwoot/consumidorInbox.integracao.test.ts', 'src/services/sac/triagem/triagem.integracao.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
