import {
  applyCanonicalMigrations,
  databaseLabCycleSteps,
  DATABASE_LAB_CLEANUP,
  executeSupabaseStep,
} from './database-lab.mjs';
import { writeCatalogReference } from './database-catalog.mjs';
import { failureMessage } from './script-result.mjs';

/**
 * Regenera `database/catalog-reference.json` a partir de um laboratorio
 * descartavel com a cadeia canonica de migrations aplicada.
 *
 * Existe porque `npm run db:catalog:write` sozinho exige um banco local JA
 * reconstruido, e o laboratorio do `test:db` e destruido no fim do ciclo. Sem
 * isto, a unica forma de atualizar o contrato do catalogo depois de mudar uma
 * migration era subir o laboratorio a mao e lembrar a ordem certa dos passos.
 */
const [start] = databaseLabCycleSteps('catalog rebuild');

let resultado;
try {
  const started = executeSupabaseStep(start);
  if (started._tag === 'err') {
    resultado = started;
  } else {
    const applied = await applyCanonicalMigrations({});
    resultado = applied._tag === 'err' ? applied : await writeCatalogReference();
  }
} finally {
  executeSupabaseStep(DATABASE_LAB_CLEANUP);
}

if (resultado._tag === 'err') {
  console.error(`[catalog] ${resultado.error._tag}: ${failureMessage(resultado.error)}`);
  process.exitCode = 1;
} else {
  console.log(`[catalog] contrato regravado com fingerprint ${resultado.value.fingerprint}.`);
}
