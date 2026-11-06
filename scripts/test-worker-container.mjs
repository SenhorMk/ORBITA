import { spawnSync } from 'node:child_process';

import {
  alinharStubDeAuthComProducao,
  applyCanonicalMigrations,
  databaseLabCycleSteps,
  DATABASE_LAB_CLEANUP,
  executeSupabaseStep,
} from './database-lab.mjs';
import { rodarProvaComPostgrest } from './database-integracao-consumidor-inbox.mjs';
import { err, failureMessage } from './script-result.mjs';

/**
 * MSG-020A. Constrói a imagem do worker a partir do código atual e prova o
 * container contra o laboratório descartável. Não fala com nenhum provedor.
 */

let resultado;
try {
  const build = spawnSync('docker', ['build', '-f', 'infra/worker/Dockerfile', '-t', 'orbita-worker:local', '.'], {
    encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, timeout: 900_000,
  });
  if (build.status !== 0) throw new Error(`A imagem do worker não foi construída: ${String(build.stderr).slice(-600)}`);
  const [start] = databaseLabCycleSteps('prova do worker em container');
  const iniciado = executeSupabaseStep(start);
  const alinhado = iniciado._tag === 'err' ? iniciado : await alinharStubDeAuthComProducao();
  const aplicado = alinhado._tag === 'err' ? alinhado : await applyCanonicalMigrations({});
  resultado = aplicado._tag === 'err' ? aplicado : await rodarProvaComPostgrest({
    config: 'vitest.worker-container.config.ts',
    relato: (testes) => `prova do MSG-020A com a imagem do worker contra o laboratório: ${testes} testes`,
  });
} catch (causa) {
  resultado = err('WorkerContainerFalhou', causa instanceof Error ? causa.message : 'Falha inesperada');
} finally {
  executeSupabaseStep(DATABASE_LAB_CLEANUP);
}

if (resultado._tag === 'err') {
  console.error(`[worker-container] ${resultado.error._tag}: ${failureMessage(resultado.error)}`);
  process.exitCode = 1;
} else {
  console.log(`[worker-container] ${resultado.value.relato}`);
}
