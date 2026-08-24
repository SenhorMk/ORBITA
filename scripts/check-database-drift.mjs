import path from 'node:path';

import { validateCanonicalLedger } from './database-ledger.mjs';
import { failureMessage } from './script-result.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/check-database-drift.mjs')) {
  const result = validateCanonicalLedger();
  if (result._tag === 'err') {
    console.error(`Database migration drift detected: ${failureMessage(result.error)}`);
    process.exitCode = 1;
  } else {
    console.log(`Database migration ledger verified (${result.value.checkedFiles} SQL files, ordered SHA-256 checksums intact).`);
  }
}
