import { describe, expect, it } from 'vitest';

import { createLocalDatabaseClient } from './local-database-client.mjs';

describe('local database client diagnostics', () => {
  it('forwards PostgreSQL notices through a secret-free projection', () => {
    const warnings: string[] = [];
    const client = createLocalDatabaseClient('notice-test', {
      warn: (message: string) => warnings.push(message),
    });

    client.emit('notice', {
      severity: 'WARNING',
      code: '01000',
      message: 'migration emitted a warning',
      detail: 'must not be logged',
    });

    expect(warnings).toEqual(['[database-lab] postgres WARNING 01000: migration emitted a warning']);
  });
});
