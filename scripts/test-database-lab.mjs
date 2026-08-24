import { runDatabaseLab } from './database-lab.mjs';
import { failureMessage } from './script-result.mjs';

const result = await runDatabaseLab({ rehearseFailure: true });
if (result._tag === 'err') {
  console.error(`[database-lab] ${result.error._tag}: ${failureMessage(result.error)}`);
  process.exitCode = 1;
} else {
  console.log(`[database-lab] complete: ${result.value.cycles} clean cycles, catalog ${result.value.catalogFingerprint}`);
}
