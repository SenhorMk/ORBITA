import { runDatabaseLab } from './database-lab.mjs';

try {
  runDatabaseLab();
} catch (error) {
  console.error('[database-lab] failed', error);
  process.exitCode = 1;
}
