import { describe, expect, it } from 'vitest';

import { parseOrganizationId, type OrganizationContextResult, type OrganizationId } from '@/lib/organizationAuthorization';
import { createOrganizationSwitchHandler } from './route';

const CURRENT = '10000000-0000-4000-8000-000000000001';
function testOrganizationId(): OrganizationId {
  const result = parseOrganizationId('20000000-0000-4000-8000-000000000001');
  if (!result) throw new Error('Test organization UUID must be valid.');
  return result;
}
const TARGET = testOrganizationId();

function request(expectedVersion = 0): Request {
  return new Request('https://orbita.test/api/organizacoes/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizacao_id: TARGET, expected_version: expectedVersion }),
  });
}

function resolved(): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    // SAFETY: the handler test supplies a complete context fixture; only private construction brands are omitted.
    context: {
      actorId: '30000000-0000-4000-8000-000000000001',
      user: { id: '30000000-0000-4000-8000-000000000001', app_metadata: {} },
      organizationId: TARGET,
      organization: {
        id: TARGET,
        nome: 'Destino',
        slug: 'destino',
        created_at: '2026-08-24T00:00:00Z',
        updated_at: '2026-08-24T00:00:00Z',
      },
      role: 'owner',
      capabilities: new Set(['organization:access', 'organization:manage']),
      selectionVersion: 0,
    } as never,
  };
}

describe('POST /api/organizacoes/switch', () => {
  it('persists a switch only after target membership authorization', async () => {
    let activeOrganization: string | null = CURRENT;
    const handler = createOrganizationSwitchHandler({
      resolveContext: async (requestUnderTest, selection) => (
        requestUnderTest.url.endsWith('/api/organizacoes/switch')
          && selection._tag === 'ExactOrganization' && selection.organizationId === TARGET
          ? resolved()
          : { _tag: 'OrganizationAccessDenied' }
      ),
      switchActiveOrganization: async () => ({ _tag: 'OrganizationSwitchApplied', version: 1 }),
      setActiveOrganization: async (organizationId) => { activeOrganization = organizationId; },
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(activeOrganization).toBe(TARGET);
  });

  it('denies foreign and revoked memberships without changing the active organization', async () => {
    let activeOrganization: string | null = CURRENT;
    const handler = createOrganizationSwitchHandler({
      resolveContext: async () => ({ _tag: 'OrganizationAccessDenied' }),
      switchActiveOrganization: async () => ({ _tag: 'OrganizationSwitchDenied' }),
      setActiveOrganization: async (organizationId) => { activeOrganization = organizationId; },
    });
    const response = await handler(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Não autorizado' });
    expect(activeOrganization).toBe(CURRENT);
  });

  it('rejects a replay after the active organization changed', async () => {
    let activeOrganization: string | null = TARGET;
    const handler = createOrganizationSwitchHandler({
      resolveContext: async () => resolved(),
      switchActiveOrganization: async () => ({ _tag: 'OrganizationSwitchStale' }),
      setActiveOrganization: async (organizationId) => { activeOrganization = organizationId; },
    });
    const response = await handler(request(0));
    expect(response.status).toBe(409);
    expect(activeOrganization).toBe(TARGET);
  });
});
