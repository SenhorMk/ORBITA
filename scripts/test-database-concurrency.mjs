import {
  applyCanonicalMigrations,
  databaseLabCycleSteps,
  DATABASE_LAB_CLEANUP,
  executeSupabaseStep,
} from './database-lab.mjs';
import { runManualOrderRaceRehearsal } from './database-concurrency.mjs';
import { failureMessage } from './script-result.mjs';

/**
 * Sobe seu proprio laboratorio descartavel (nao reaproveita o de
 * `database-lab.mjs` — este script roda DEPOIS que aquele ja derrubou o seu),
 * aplica a cadeia canonica de migrations, dispara o rehearsal de concorrencia
 * do ticket 30, e derruba o laboratorio de novo. Reusa so as pecas ja
 * testadas de `database-lab.mjs` — nao adiciona um passo novo a orquestracao
 * generica de la, que tem teste proprio com fakes.
 */
const [start] = databaseLabCycleSteps('concurrency rehearsal');

let outcome;
try {
  const started = executeSupabaseStep(start);
  if (started._tag === 'err') {
    outcome = started;
  } else {
    const applied = await applyCanonicalMigrations({});
    outcome = applied._tag === 'err' ? applied : await runManualOrderRaceRehearsal();
  }
} finally {
  executeSupabaseStep(DATABASE_LAB_CLEANUP);
}

if (outcome._tag === 'err') {
  console.error(`[database-concurrency] ${outcome.error._tag}: ${failureMessage(outcome.error)}`);
  process.exitCode = 1;
} else {
  console.log(
    `[database-concurrency] atomicidade provada: vencedora ${outcome.value.vencedora}, `
      + `perdedora ${outcome.value.perdedoraCode}, estoque ${outcome.value.estoqueFinal}, `
      + `reservado ${outcome.value.estoqueReservadoFinal}`,
  );
}
