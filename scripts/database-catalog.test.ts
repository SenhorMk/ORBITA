import { describe, expect, it } from 'vitest';

import { catalogFingerprint, validateCatalogReference } from './database-catalog.mjs';

describe('database catalog reference', () => {
  it('produces the same fingerprint for equivalent key ordering', () => {
    expect(catalogFingerprint({ tables: [{ owner: 'postgres', name: 'orders' }] }))
      .toBe(catalogFingerprint({ tables: [{ name: 'orders', owner: 'postgres' }] }));
  });

  it('fails closed when the final schema differs from the committed reference', () => {
    const capture = {
      fingerprint: 'current',
      counts: { tables: 10 },
      snapshot: {},
    };
    const result = validateCatalogReference(capture, {
      version: 1,
      fingerprint: 'expected',
      counts: { tables: 9 },
    });
    expect(result._tag).toBe('err');
    if (result._tag === 'err') expect(result.error.message).toContain('catalog fingerprint mismatch');
  });
});
