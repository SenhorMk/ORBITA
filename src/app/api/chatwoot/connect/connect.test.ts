import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'cd'.repeat(32);

const mockUpsertCreds = vi.fn().mockResolvedValue(undefined);
let existingConnection: { id: string } | null = null;
/** O que a rota realmente gravou na linha da conexão, para o teste inspecionar. */
const escritas: Array<{ op: 'insert' | 'update'; values: Record<string, unknown> }> = [];

vi.mock('@/lib/requestOrganizationContext', () => ({
  resolveActiveRequestOrganizationContext: vi.fn(),
}));

vi.mock('@/lib/integrations/credentialsVault', async () => {
  const actual = await vi.importActual<typeof import('@/lib/integrations/credentialsVault')>(
    '@/lib/integrations/credentialsVault',
  );
  return {
    ...actual,
    credentialsVault: {
      saveEncryptedCredentials: (...args: unknown[]) => mockUpsertCreds(...args),
    },
  };
});

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    from: (table: string) => {
      if (table === 'conexoes_integracao') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: existingConnection, error: null }),
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => {
            escritas.push({ op: 'update', values });
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
          insert: (values: Record<string, unknown>) => {
            escritas.push({ op: 'insert', values });
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: 'new-conexao-id' }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

describe('POST /api/chatwoot/connect', () => {
  beforeAll(() => {
    existingConnection = null;
  });

  async function callConnect(body: unknown) {
    const { resolveActiveRequestOrganizationContext } = await import('@/lib/requestOrganizationContext');
    vi.mocked(resolveActiveRequestOrganizationContext).mockResolvedValue({
      _tag: 'OrganizationContextResolved',
      context: {
        actorId: 'actor-1',
        organizationId: 'org-1',
        role: 'owner',
        capabilities: new Set(['organization:access', 'organization:manage']),
      } as never,
    });
    const { POST } = await import('./route');
    const req = new Request('https://orbita.test/api/chatwoot/connect', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it('rejects unauthenticated requests', async () => {
    const { resolveActiveRequestOrganizationContext } = await import('@/lib/requestOrganizationContext');
    vi.mocked(resolveActiveRequestOrganizationContext).mockResolvedValue({ _tag: 'SessionMissing' } as never);
    const { POST } = await import('./route');
    const res = await POST(new Request('https://orbita.test/api/chatwoot/connect', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
  });

  it('rejects a member without organization:manage capability', async () => {
    const { resolveActiveRequestOrganizationContext } = await import('@/lib/requestOrganizationContext');
    vi.mocked(resolveActiveRequestOrganizationContext).mockResolvedValue({
      _tag: 'OrganizationContextResolved',
      context: { actorId: 'a', organizationId: 'org-1', role: 'member', capabilities: new Set(['organization:access']) } as never,
    });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://orbita.test/api/chatwoot/connect', {
        method: 'POST',
        body: JSON.stringify({ api_token: 'tok', account_id: '1', webhook_secret: 'sec' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects an invalid credentials payload', async () => {
    const res = await callConnect({ api_token: '' });
    expect(res.status).toBe(400);
  });

  it('creates a new connection and stores encrypted credentials', async () => {
    existingConnection = null;
    mockUpsertCreds.mockClear();
    const res = await callConnect({ api_token: 'tok-123', account_id: '42', webhook_secret: 'wh-secret-value' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, conexaoId: 'new-conexao-id', webhookUrl: '/api/chatwoot/webhook/new-conexao-id' });
    expect(mockUpsertCreds).toHaveBeenCalledWith(
      'org-1',
      'new-conexao-id',
      expect.objectContaining({ api_token: 'tok-123', account_id: '42', webhook_secret: 'wh-secret-value' }),
    );
  });

  it('salvar credenciais não declara a instância conectada', async () => {
    existingConnection = null;
    escritas.length = 0;
    await callConnect({ api_token: 'tok-123', account_id: '42', webhook_secret: 'wh-secret-value' });
    // Nada aqui provou que a URL responde, que o token vale ou que a conta
    // existe. `conectado` seria uma afirmação sem evidência nenhuma.
    expect(escritas.at(-1)?.values).toMatchObject({ status: 'pendente' });
    expect(JSON.stringify(escritas)).not.toContain('conectado');
  });

  it('regravar credenciais apaga a evidência de saúde das credenciais anteriores', async () => {
    existingConnection = { id: 'conexao-existente' };
    escritas.length = 0;
    await callConnect({ api_token: 'tok-novo', account_id: '42', webhook_secret: 'wh-secret-value' });
    expect(escritas.at(-1)).toMatchObject({
      op: 'update',
      values: { status: 'pendente', last_health_check_at: null, last_health_error: null },
    });
    existingConnection = null;
  });

  it('devolve a URL do webhook absoluta quando a origem estável está configurada', async () => {
    existingConnection = null;
    const anterior = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = 'https://orbita.mkautobots.site';
    try {
      const res = await callConnect({ api_token: 'tok-123', account_id: '42', webhook_secret: 'wh-secret-value' });
      // Relativo não serve: este endereço é colado dentro do Chatwoot.
      await expect(res.json()).resolves.toMatchObject({
        webhookUrl: 'https://orbita.mkautobots.site/api/chatwoot/webhook/new-conexao-id',
      });
    } finally {
      process.env.APP_BASE_URL = anterior;
    }
  });
});
