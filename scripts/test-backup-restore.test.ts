import { describe, it, expect } from 'vitest';
import {
  simulateLogicalBackup,
  simulateLogicalRestore,
} from './test-backup-restore.mjs';

describe('backup & restore simulation script', () => {
  it('simulateLogicalBackup gera metadados com cronometragem', () => {
    const backup = simulateLogicalBackup({ clientes: 10, pedidos: 20 });
    expect(backup.status).toBe('completed');
    expect(backup.tableCount).toBe(2);
    expect(backup.recordCount).toBe(30);
    expect(backup.durationMs).toBeGreaterThan(0);
  });

  it('simulateLogicalRestore processa o backup com sucesso', () => {
    const backup = simulateLogicalBackup({ clientes: 5, notas: 15 });
    const restore = simulateLogicalRestore(backup);

    expect(restore.status).toBe('restored');
    expect(restore.restoredTables).toBe(2);
    expect(restore.restoredRecords).toBe(20);
    expect(restore.durationMs).toBeGreaterThan(0);
  });

  it('simulateLogicalRestore falha com backup inválido', () => {
    expect(() => simulateLogicalRestore(null)).toThrow('Backup metadata inválido ou incompleto');
  });
});
