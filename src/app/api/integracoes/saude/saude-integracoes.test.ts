import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  ORG_ID,
  USER_ID,
  mockVerifySessionAndRole,
  mockResolveActiveOrganization,
  mockGetIntegrationsHealth,
} = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

  const ORG_ID = 'cccccccc-0000-0000-0000-000000000003';
  const USER_ID = 'dddddddd-0000-0000-0000-000000000004';

  return {
    ORG_ID,
    USER_ID,
    mockVerifySessionAndRole: vi.fn(),
    mockResolveActiveOrganization: vi.fn(),
    mockGetIntegrationsHealth: vi.fn(),
  };
});

vi.mock('../../../../lib/supabaseServer', () => ({
  supabaseServer: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('../../../../lib/auth', () => ({
  verifySessionAndRole: (...args: unknown[]) => mockVerifySessionAndRole(...args),
}));

vi.mock('../../../../lib/organizationContext', () => ({
  resolveActiveOrganization: (...args: unknown[]) => mockResolveActiveOrganization(...args),
}));

vi.mock('../../../../services/outboxService', () => ({
  outboxService: {
    getIntegrationsHealth: (...args: unknown[]) => mockGetIntegrationsHealth(...args),
  },
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionAndRole.mockResolvedValue({
    id: USER_ID,
    actorId: USER_ID,
    role: 'dono',
    tenant: { id: USER_ID, organizacao_id: ORG_ID },
  });
  mockResolveActiveOrganization.mockResolvedValue({
    organizacao: { id: ORG_ID, nome: 'Minha Empresa', slug: 'minha-empresa' },
    papel: 'owner',
  });
  mockGetIntegrationsHealth.mockResolvedValue([
    {
      id: 'conn-1',
      provedor: 'bling',
      nome: 'Principal',
      status: 'conectado',
      health_status: 'healthy',
      last_health_check_at: '2026-08-20T16:00:00Z',
      last_health_error: null,
    },
    {
      id: 'conn-2',
      provedor: 'chatwoot',
      nome: 'Principal',
      status: 'conectado',
      health_status: 'degraded',
      last_health_check_at: '2026-08-20T16:10:00Z',
      last_health_error: 'Timeout na API',
    },
  ]);
});

describe('GET /api/integracoes/saude', () => {
  it('retorna a lista de conexões e respectivos estados de saúde para organização autenticada', async () => {
    const req = new NextRequest('http://localhost/api/integracoes/saude');
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.organizacao_id).toBe(ORG_ID);
    expect(body.conexoes).toHaveLength(2);
    expect(body.conexoes[0].health_status).toBe('healthy');
    expect(body.conexoes[1].health_status).toBe('degraded');
  });

  it('retorna 401 para requisição não autenticada', async () => {
    mockVerifySessionAndRole.mockResolvedValueOnce(null);

    const req = new NextRequest('http://localhost/api/integracoes/saude');
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Não autorizado');
  });

  it('retorna 500 caso o serviço falhe', async () => {
    mockGetIntegrationsHealth.mockRejectedValueOnce(new Error('Falha no banco'));

    const req = new NextRequest('http://localhost/api/integracoes/saude');
    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Falha no banco');
  });
});
