import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'cd'.repeat(32);

const mockUpsertCreds = vi.fn().mockResolvedValue(undefined);
let existingConnection: { id: string } | null = null;
/** Linhas removidas pela compensação, com o filtro que as removeu. */
const remocoes: Array<Record<string, unknown>> = [];
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
          delete: () => {
            const filtros: Record<string, unknown> = {};
            const builder = {
              eq(coluna: string, valor: unknown) {
                filtros[coluna] = valor;
                if (Object.keys(filtros).length === 2) {
                  remocoes.push(filtros);
                  return Promise.resolve({ error: null });
                }
                return builder;
              },
            };
            return builder;
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

  describe('organização do corpo (PRE-008)', () => {
    const credenciais = { api_token: 'tok-123', account_id: '42', webhook_secret: 'wh-secret-value' };

    it('organizacao_esperada que não é texto é entrada inválida, e nada é gravado', async () => {
      escritas.length = 0;
      mockUpsertCreds.mockClear();
      for (const organizacao_esperada of [123, { id: 'org-1' }, ['org-1'], '']) {
        const res = await callConnect({ ...credenciais, organizacao_esperada });
        expect(res.status).toBe(400);
      }
      expect(escritas).toEqual([]);
      expect(mockUpsertCreds).not.toHaveBeenCalled();
    });

    it('outra organização no corpo não é autoridade: 409, sem escrita', async () => {
      escritas.length = 0;
      mockUpsertCreds.mockClear();
      const res = await callConnect({ ...credenciais, organizacao_esperada: 'org-2' });
      expect(res.status).toBe(409);
      expect(escritas).toEqual([]);
      expect(mockUpsertCreds).not.toHaveBeenCalled();
    });

    it('organizacao_id no corpo é ignorado: grava na organização da sessão', async () => {
      existingConnection = null;
      escritas.length = 0;
      mockUpsertCreds.mockClear();
      const res = await callConnect({ ...credenciais, organizacao_id: 'org-2', organizacao_esperada: 'org-1' });
      expect(res.status).toBe(200);
      expect(escritas).toEqual([{ op: 'insert', values: expect.objectContaining({ organizacao_id: 'org-1' }) }]);
      expect(mockUpsertCreds).toHaveBeenCalledWith('org-1', 'new-conexao-id', credenciais);
    });

    it('a resposta nunca devolve token nem segredo', async () => {
      existingConnection = null;
      const res = await callConnect({ ...credenciais, organizacao_esperada: 'org-1' });
      const texto = JSON.stringify(await res.json());
      expect(texto).not.toContain('tok-123');
      expect(texto).not.toContain('wh-secret-value');
    });

    it('nem o log de uma falha do cofre leva token ou segredo', async () => {
      existingConnection = null;
      const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')];
      for (const espiao of logs) espiao.mockImplementation(() => undefined);
      mockUpsertCreds.mockRejectedValueOnce(new Error('cofre indisponível'));
      try {
        const res = await callConnect({ ...credenciais, organizacao_esperada: 'org-1' });
        expect(res.status).toBe(500);
        const registrado = JSON.stringify(logs.flatMap((espiao) => espiao.mock.calls));
        expect(registrado).toContain('cofre indisponível');
        expect(registrado).not.toContain('tok-123');
        expect(registrado).not.toContain('wh-secret-value');
      } finally {
        for (const espiao of logs) espiao.mockRestore();
      }
    });
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

  describe('falha do cofre (revisão externa da PR #85)', () => {
    it('conexão nova: a linha criada é desfeita, para não sobrar "configurado" falso', async () => {
      existingConnection = null;
      escritas.length = 0;
      remocoes.length = 0;
      mockUpsertCreds.mockRejectedValueOnce(new Error('cofre indisponível'));

      const res = await callConnect({ api_token: 'tok-123', account_id: '42', webhook_secret: 'wh-secret-value' });

      expect(res.status).toBe(500);
      // Para o Chatwoot, a existência da linha É a evidência de configuração:
      // não há `client_id` em metadata para servir de marca. Uma linha sem
      // credencial no cofre faria a tela dizer "Não verificado" — isto é,
      // "configurado" — para quem não tem token nenhum guardado.
      expect(remocoes).toEqual([{ id: 'new-conexao-id', organizacao_id: 'org-1' }]);
    });

    it('substituição: a linha existente não é apagada, e não fica "conectado"', async () => {
      existingConnection = { id: 'conexao-existente' };
      escritas.length = 0;
      remocoes.length = 0;
      mockUpsertCreds.mockRejectedValueOnce(new Error('cofre indisponível'));

      const res = await callConnect({ api_token: 'tok-novo', account_id: '42', webhook_secret: 'wh-secret-value' });

      expect(res.status).toBe(500);
      // Nada a compensar: o cofre grava as credenciais numa linha só, então ou
      // aceitou o conjunto novo ou o antigo continua inteiro. Apagar a conexão
      // aqui destruiria uma configuração que ainda funciona.
      expect(remocoes).toEqual([]);
      expect(escritas.at(-1)?.values).toMatchObject({ status: 'pendente' });
      expect(JSON.stringify(escritas)).not.toContain('conectado');
      existingConnection = null;
    });
  });

  it('o 500 não vaza o erro interno do banco, do cofre ou do provedor', async () => {
    existingConnection = null;
    mockUpsertCreds.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "credenciais_integracao_conexao_id_key"'),
    );

    const res = await callConnect({ api_token: 'tok-123', account_id: '42', webhook_secret: 'wh-secret-value' });

    expect(res.status).toBe(500);
    const corpo = await res.json();
    expect(corpo.error).toBe('Não foi possível salvar as credenciais do Chatwoot. Tente novamente.');
    // Nome de tabela, de constraint e o texto do Postgres ficam no log redigido.
    expect(JSON.stringify(corpo)).not.toContain('credenciais_integracao');
    expect(JSON.stringify(corpo)).not.toContain('duplicate key');
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
