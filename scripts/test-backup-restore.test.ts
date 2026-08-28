import { describe, it, expect } from 'vitest';
import { multiTenantSmoke, criticalJourneySmoke } from './test-backup-restore.mjs';

/**
 * Fake pg client (sem `vi.mock`), keyed on call order — `multiTenantSmoke` issues its five
 * queries (org A, org B, clientes A, clientes B, cross-tenant leak) in a fixed sequence.
 */
function orderedFakeClient(results: unknown[]) {
  let call = 0;
  return {
    query: async () => {
      const result = results[call];
      call += 1;
      if (result === undefined) throw new Error('fake client received more queries than expected');
      return result;
    },
  };
}

describe('multiTenantSmoke', () => {
  it('reports no errors when each synthetic tenant only sees its own rows', async () => {
    const client = orderedFakeClient([
      { rows: [{ count: 1 }] }, // org A present
      { rows: [{ count: 1 }] }, // org B present
      { rows: [{ count: 2 }] }, // clientes A count
      { rows: [{ count: 1 }] }, // clientes B count
      { rows: [{ count: 0 }] }, // cross-tenant leak count
    ]);
    const errors = await multiTenantSmoke(client as never);
    expect(errors).toEqual([]);
  });

  it('reports a cross-tenant leak when tenant A can see tenant B rows', async () => {
    const client = orderedFakeClient([
      { rows: [{ count: 1 }] },
      { rows: [{ count: 1 }] },
      { rows: [{ count: 2 }] },
      { rows: [{ count: 1 }] },
      { rows: [{ count: 1 }] }, // leak detected
    ]);
    const errors = await multiTenantSmoke(client as never);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('vazamento cross-tenant')]));
  });

  it('reports when a synthetic tenant did not survive the restore', async () => {
    const client = orderedFakeClient([
      { rows: [{ count: 0 }] }, // org A missing
      { rows: [{ count: 1 }] },
      { rows: [{ count: 2 }] },
      { rows: [{ count: 1 }] },
      { rows: [{ count: 0 }] },
    ]);
    const errors = await multiTenantSmoke(client as never);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('organização sintética A não sobreviveu')]));
  });
});

describe('criticalJourneySmoke', () => {
  it('reports no errors when criar_organizacao_atomica survives the restore', async () => {
    const client = { query: async () => ({ rows: [{ count: 1 }] }) };
    const errors = await criticalJourneySmoke(client as never);
    expect(errors).toEqual([]);
  });

  it('reports a broken journey when criar_organizacao_atomica is missing after restore', async () => {
    const client = { query: async () => ({ rows: [{ count: 0 }] }) };
    const errors = await criticalJourneySmoke(client as never);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('criar_organizacao_atomica ausente')]));
  });
});
