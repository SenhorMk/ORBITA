

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

/**
 * @typedef {Object} BackupMetadata
 * @property {string} timestamp
 * @property {number} tableCount
 * @property {number} recordCount
 * @property {number} durationMs
 * @property {string} [checksum]
 * @property {string} status
 */

/**
 * @param {Record<string, number>} [mockData]
 */
export function simulateLogicalBackup(mockData = { organizacoes: 10, membros: 25, syncJobs: 50 }) {
  const startTime = Date.now();

  const totalRecords = Object.values(mockData).reduce((sum, count) => sum + count, 0);
  const tables = Object.keys(mockData);

  const durationMs = Date.now() - startTime + 5; // simulated execution

  const backupMetadata = {
    timestamp: new Date().toISOString(),
    tableCount: tables.length,
    recordCount: totalRecords,
    durationMs,
    status: 'completed',
  };

  return backupMetadata;
}

export function simulateLogicalRestore(backupMetadata) {
  const startTime = Date.now();

  if (!backupMetadata || backupMetadata.status !== 'completed') {
    throw new Error('Backup metadata inválido ou incompleto');
  }

  const durationMs = Date.now() - startTime + 8; // simulated execution

  return {
    timestamp: new Date().toISOString(),
    restoredTables: backupMetadata.tableCount,
    restoredRecords: backupMetadata.recordCount,
    durationMs,
    status: 'restored',
  };
}

if (process.argv[1] === __filename) {
  console.log('📦 Executando ensaio cronometrado de backup e restore...');
  const backup = simulateLogicalBackup();
  console.log(`✅ Backup lógico simulado com sucesso (${backup.recordCount} registros em ${backup.durationMs}ms)`);

  const restore = simulateLogicalRestore(backup);
  console.log(`✅ Restore lógico simulado com sucesso (${restore.restoredRecords} registros em ${restore.durationMs}ms)`);
}
