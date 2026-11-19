import { spawnSync } from 'node:child_process';

import {
  alinharStubDeAuthComProducao,
  applyCanonicalMigrations,
  databaseLabCycleSteps,
  DATABASE_LAB_CLEANUP,
  executeSupabaseStep,
} from './database-lab.mjs';
import { rodarProvaComPostgrest } from './database-integracao-consumidor-inbox.mjs';
import { failureMessage } from './script-result.mjs';

const projeto = DATABASE_LAB_CLEANUP.args[2];
const inventario = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' });
if (inventario.status !== 0 || inventario.stdout.split(/\r?\n/u).some((nome) => nome.endsWith(projeto) || nome === `${projeto}-postgrest`)) {
  console.error('[mvp] Docker indisponível ou laboratório já em uso.');
  process.exit(1);
}

const [start] = databaseLabCycleSteps('MVP chat com resposta');
let resultado;
try {
  resultado = executeSupabaseStep(start);
  if (resultado._tag === 'ok') resultado = await alinharStubDeAuthComProducao();
  if (resultado._tag === 'ok') resultado = await applyCanonicalMigrations({});
  if (resultado._tag === 'ok') resultado = await rodarProvaComPostgrest({
    config: 'vitest.integracao.config.ts',
    relato: (testes) => `Provas integradas do MVP, inbox e triagem: ${testes} testes.`,
  });
} finally {
  const cleanup = executeSupabaseStep(DATABASE_LAB_CLEANUP);
  if (cleanup._tag === 'err') process.exitCode = 1;
}
if (resultado._tag === 'err') {
  console.error(`[mvp] ${resultado.error._tag}: ${failureMessage(resultado.error)}`);
  process.exitCode = 1;
} else console.log(resultado.value.relato);
