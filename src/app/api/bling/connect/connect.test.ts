import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'cd'.repeat(32);

/** Registro de uma operação executada contra o Supabase pela rota sob teste. */
interface RecordedQuery {
  readonly table: string;
  readonly op: 'select' | 'insert' | 'update';
  readonly filters: Record<string, unknown>;
  readonly values: Record<string, unknown> | null;
}

const recordedQueries: RecordedQuery[] = [];
const savedVaultCalls: Array<{ orgId: string; conexaoId: string; credentials: Record<string, unknown> }> = [];

/** Linhas de `conexoes_integracao` visíveis ao teste, indexadas por organização. */
const connectionRows = new Map<string, { id: string; metadata: Record<string, unknown> }>();

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
      saveEncryptedCredentials: (orgId: string, conexaoId: string, credentials: Record<string, unknown>) => {
        savedVaultCalls.push({ orgId, conexaoId, credentials });
        return Promise.resolve();
      },
    },
  };
});

vi.mock('@/lib/supabaseServer', () => {
  function selectBuilder(table: string) {
    const filters: Record<string, unknown> = {};
    const builder = {
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      maybeSingle() {
        recordedQueries.push({ table, op: 'select', filters, values: null });
        const organizacaoId = String(filters.organizacao_id ?? '');
        const row = filters.provedor === 'bling' ? connectionRows.get(organizacaoId) : undefined;
        return Promise.resolve({ data: row ?? null, error: null });
      },
    };
    return builder;
  }

  return {
    supabaseServer: {
      from(table: string) {
        if (table !== 'conexoes_integracao') {
          throw new Error(`unexpected table ${table}`);
        }
        return {
          select: () => selectBuilder(table),
          insert(values: Record<string, unknown>) {
            return {
              select: () => ({
                single: () => {
                  recordedQueries.push({ table, op: 'insert', filters: {}, values });
                  const id = `conexao-${String(values.organizacao_id)}`;
                  connectionRows.set(String(values.organizacao_id), {
                    id,
                    // SAFETY: o valor gravado pela rota é serializável e apenas ecoado de volta pelo duplo de teste.
                    metadata: (values.metadata ?? {}) as Record<string, unknown>,
                  });
                  return Promise.resolve({ data: { id }, error: null });
                },
              }),
            };
          },
          update(values: Record<string, unknown>) {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                if (Object.keys(filters).length === 2) {
                  recordedQueries.push({ table, op: 'update', filters, values });
                  return Promise.resolve({ error: null });
                }
                return builder;
              },
            };
            return builder;
          },
        };
      },
    },
  };
});

type Capability = 'organization:access' | 'organization:manage';

async function callConnect(
  body: unknown,
  options: { organizationId?: string; capabilities?: Capability[] } = {},
) {
  const { resolveActiveRequestOrganizationContext } = await import('@/lib/requestOrganizationContext');
  vi.mocked(resolveActiveRequestOrganizationContext).mockResolvedValue({
    _tag: 'OrganizationContextResolved',
    context: {
      actorId: 'actor-1',
      organizationId: options.organizationId ?? 'org-1',
      role: 'owner',
      capabilities: new Set<string>(options.capabilities ?? ['organization:access', 'organization:manage']),
    } as never,
  } as never);
  const { POST } = await import('./route');
  return POST(
    new Request('https://orbita.test/api/bling/connect', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/bling/connect', () => {
  beforeEach(() => {
    recordedQueries.length = 0;
    savedVaultCalls.length = 0;
    connectionRows.clear();
  });

  it('rejeita requisição sem sessão verificada', async () => {
    const { resolveActiveRequestOrganizationContext } = await import('@/lib/requestOrganizationContext');
    vi.mocked(resolveActiveRequestOrganizationContext).mockResolvedValue({ _tag: 'SessionMissing' } as never);
    const { POST } = await import('./route');

    const res = await POST(
      new Request('https://orbita.test/api/bling/connect', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(401);
    expect(recordedQueries).toHaveLength(0);
    expect(savedVaultCalls).toHaveLength(0);
  });

  it('rejeita membro sem a capacidade organization:manage com 403', async () => {
    const res = await callConnect(
      { clientId: 'client-abc', clientSecret: 'secret-xyz' },
      { capabilities: ['organization:access'] },
    );

    expect(res.status).toBe(403);
    expect(recordedQueries).toHaveLength(0);
    expect(savedVaultCalls).toHaveLength(0);
  });

  it('rejeita corpo inválido com 400 e não escreve nada', async () => {
    const res = await callConnect({ clientId: '', clientSecret: '' });

    expect(res.status).toBe(400);
    expect(recordedQueries).toHaveLength(0);
    expect(savedVaultCalls).toHaveLength(0);
  });

  it('aceita exatamente o corpo que o cliente monta pelo contrato compartilhado', async () => {
    // Acopla as duas pontas da fronteira: o corpo é montado pela mesma função
    // que a UI usa, e validado pelo mesmo schema que a rota usa. Uma
    // divergência de forma entre cliente e servidor falha aqui.
    const { buildBlingCredentialsPayload } = await import('@/lib/config/blingCredentialsContract');

    const res = await callConnect(buildBlingCredentialsPayload('  client-abc  ', '  secret-xyz  '));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, conexaoId: 'conexao-org-1', status: 'pendente' });
  });

  it('cria a conexão da organização com o client_id em metadata e o secret cifrado no cofre', async () => {
    const res = await callConnect({ clientId: 'client-abc', clientSecret: 'secret-xyz' });

    expect(res.status).toBe(200);
    const insert = recordedQueries.find((q) => q.op === 'insert');
    expect(insert?.values).toMatchObject({
      organizacao_id: 'org-1',
      provedor: 'bling',
      nome: 'Principal',
      status: 'pendente',
      metadata: { client_id: 'client-abc' },
    });
    expect(savedVaultCalls).toEqual([
      { orgId: 'org-1', conexaoId: 'conexao-org-1', credentials: { client_id: 'client-abc', client_secret: 'secret-xyz' } },
    ]);
  });

  it('nunca grava o client_secret fora do cofre nem o devolve na resposta', async () => {
    const res = await callConnect({ clientId: 'client-abc', clientSecret: 'secret-xyz' });

    const bodyText = await res.text();
    expect(bodyText).not.toContain('secret-xyz');
    const persistedOutsideVault = JSON.stringify(recordedQueries);
    expect(persistedOutsideVault).not.toContain('secret-xyz');
  });

  it('é idempotente por (organizacao_id, provedor): a segunda chamada atualiza a mesma conexão', async () => {
    await callConnect({ clientId: 'client-abc', clientSecret: 'secret-xyz' });
    recordedQueries.length = 0;
    savedVaultCalls.length = 0;

    const res = await callConnect({ clientId: 'client-def', clientSecret: 'secret-uvw' });

    expect(res.status).toBe(200);
    expect(recordedQueries.filter((q) => q.op === 'insert')).toHaveLength(0);
    const update = recordedQueries.find((q) => q.op === 'update');
    expect(update?.filters).toEqual({ id: 'conexao-org-1', organizacao_id: 'org-1' });
    expect(update?.values).toMatchObject({ metadata: { client_id: 'client-def' } });
    expect(savedVaultCalls[0]?.conexaoId).toBe('conexao-org-1');
  });

  it('escopa toda leitura e escrita pela organização verificada, nunca por um id vindo do corpo', async () => {
    // Lição do ticket 26: não basta conferir os parâmetros — é preciso provar
    // que o predicado organizacional vem da sessão verificada.
    await callConnect(
      { clientId: 'client-abc', clientSecret: 'secret-xyz', organizacao_id: 'org-vitima' },
      { organizationId: 'org-1' },
    );

    for (const query of recordedQueries) {
      const scopedValue = query.op === 'insert' ? query.values?.organizacao_id : query.filters.organizacao_id;
      expect(scopedValue).toBe('org-1');
    }
    expect(JSON.stringify(recordedQueries)).not.toContain('org-vitima');
    expect(savedVaultCalls.every((call) => call.orgId === 'org-1')).toBe(true);
  });

  it('isola organizações: a organização B não lê nem sobrescreve a conexão da A', async () => {
    await callConnect({ clientId: 'client-a', clientSecret: 'secret-a' }, { organizationId: 'org-a' });
    recordedQueries.length = 0;
    savedVaultCalls.length = 0;

    await callConnect({ clientId: 'client-b', clientSecret: 'secret-b' }, { organizationId: 'org-b' });

    expect(recordedQueries.filter((q) => q.op === 'insert')).toHaveLength(1);
    expect(savedVaultCalls).toEqual([
      { orgId: 'org-b', conexaoId: 'conexao-org-b', credentials: { client_id: 'client-b', client_secret: 'secret-b' } },
    ]);
    expect(connectionRows.get('org-a')?.metadata).toEqual({ client_id: 'client-a' });
  });
});
