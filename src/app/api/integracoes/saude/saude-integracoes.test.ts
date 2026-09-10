import { describe, expect, it } from 'vitest';

import { parseOrganizationId, type OrganizationContextResult, type OrganizationId } from '../../../../lib/organizationAuthorization';
import { createIntegrationHealthHandler } from './route';

function testOrganizationId(): OrganizationId {
  const result = parseOrganizationId('cccccccc-0000-4000-8000-000000000003');
  if (!result) throw new Error('Test organization UUID must be valid.');
  return result;
}
const ORG_ID = testOrganizationId();

function resolved(): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    // SAFETY: the handler test supplies a complete immutable context fixture; only the private construction brand is omitted.
    context: {
      actorId: 'dddddddd-0000-4000-8000-000000000004',
      user: { id: 'dddddddd-0000-4000-8000-000000000004', app_metadata: {} },
      organizationId: ORG_ID,
      organization: {
        id: ORG_ID,
        nome: 'Minha Empresa',
        slug: 'minha-empresa',
        created_at: '2026-08-24T00:00:00Z',
        updated_at: '2026-08-24T00:00:00Z',
      },
      role: 'owner',
      capabilities: new Set(['organization:access', 'organization:manage']),
    } as never,
  };
}

describe('GET /api/integracoes/saude', () => {
  it('returns integration health for the canonically authorized organization', async () => {
    const handler = createIntegrationHealthHandler({
      resolveContext: async () => resolved(),
      getHealth: async () => [{
        id: 'conn-1', provedor: 'bling', nome: 'Principal', status: 'conectado',
        health_status: 'healthy', last_health_check_at: null, last_health_error: null,
        credenciais_configuradas: true,
      }],
      blingCallbackUrl: () => 'https://orbita.mkautobots.site/api/bling/callback',
      chatwootWebhookUrl: (id) => `https://orbita.mkautobots.site/api/chatwoot/webhook/${id}`,
    });
    const response = await handler(new Request('http://localhost/api/integracoes/saude'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      organizacao_id: ORG_ID,
      bling_callback_url: 'https://orbita.mkautobots.site/api/bling/callback',
    });
  });

  it('maps missing sessions and authorization-store outages safely', async () => {
    const unauthorized = createIntegrationHealthHandler({
      resolveContext: async () => ({ _tag: 'SessionMissing' }),
      getHealth: async () => [],
      blingCallbackUrl: () => 'https://orbita.mkautobots.site/api/bling/callback',
      chatwootWebhookUrl: (id) => `https://orbita.mkautobots.site/api/chatwoot/webhook/${id}`,
    });
    const unavailable = createIntegrationHealthHandler({
      resolveContext: async () => ({ _tag: 'OrganizationStoreUnavailable', cause: 'private-detail' }),
      getHealth: async () => [],
      blingCallbackUrl: () => 'https://orbita.mkautobots.site/api/bling/callback',
      chatwootWebhookUrl: (id) => `https://orbita.mkautobots.site/api/chatwoot/webhook/${id}`,
    });
    await expect(unauthorized(new Request('http://localhost'))).resolves.toMatchObject({ status: 401 });
    await expect(unavailable(new Request('http://localhost'))).resolves.toMatchObject({ status: 503 });
  });

  it('devolve a URL do webhook do Chatwoot apenas quando a conexão existe', async () => {
    const semChatwoot = createIntegrationHealthHandler({
      resolveContext: async () => resolved(),
      getHealth: async () => [],
      blingCallbackUrl: () => null,
      chatwootWebhookUrl: (id) => `https://orbita.mkautobots.site/api/chatwoot/webhook/${id}`,
    });
    expect(await (await semChatwoot(new Request('http://localhost'))).json()).toMatchObject({
      chatwoot_webhook_url: null,
    });

    const comChatwoot = createIntegrationHealthHandler({
      resolveContext: async () => resolved(),
      getHealth: async () => [{
        id: 'conn-cw', provedor: 'chatwoot', nome: 'Principal', status: 'pendente',
        health_status: 'healthy', last_health_check_at: null, last_health_error: null,
        credenciais_configuradas: false,
      }],
      blingCallbackUrl: () => null,
      chatwootWebhookUrl: (id) => `https://orbita.mkautobots.site/api/chatwoot/webhook/${id}`,
    });
    expect(await (await comChatwoot(new Request('http://localhost'))).json()).toMatchObject({
      chatwoot_webhook_url: 'https://orbita.mkautobots.site/api/chatwoot/webhook/conn-cw',
    });
  });
});
