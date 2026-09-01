/**
 * Ticket 22, revisão da fatia B — a ligação real entre a rota e o serviço.
 *
 * A rota anunciava `success: true` sem olhar para `syncResult.success`. Isso
 * era quase inofensivo enquanto o serviço rejeitava em qualquer falha; desde
 * que ele passou a encerrar o job em vez de rejeitar, "falhou" e "concluiu"
 * chegavam aqui iguais — e a tela dizia que a sincronização inicial tinha dado
 * certo, com zero registros.
 *
 * Nada do serviço é substituído por dublê aqui: a rota chama o `syncService` de
 * verdade, e só o repositório de jobs, o provedor de identidade e o cliente do
 * Bling são dublados. É a ligação que estava sem cobertura.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ORG_ID = '20000000-0000-4000-8000-000000000001';
const OWNER_ID = '30000000-0000-4000-8000-000000000001';

const {
  mockGetUser,
  mockContextoAtivo,
  mockVinculo,
  mockEnqueueJob,
  mockAcquireLease,
  mockCompleteJob,
  mockGetJobStatus,
  mockPing,
  mockGetClientes,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockContextoAtivo: vi.fn(),
  mockVinculo: vi.fn(),
  mockEnqueueJob: vi.fn(),
  mockAcquireLease: vi.fn(),
  mockCompleteJob: vi.fn(),
  mockGetJobStatus: vi.fn(),
  mockPing: vi.fn(),
  mockGetClientes: vi.fn(),
}));

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    auth: { getUser: mockGetUser },
    from: (tabela: string) => ({
      select: () => {
        if (tabela === 'contextos_organizacao_ativos') {
          return { eq: () => ({ maybeSingle: mockContextoAtivo }) };
        }
        const alvo = {
          eq: () => alvo,
          order: () => alvo,
          limit: () => alvo,
          maybeSingle: mockVinculo,
        };
        return alvo;
      },
    }),
  },
}));
vi.mock('@/services/bling', () => ({
  bling: {
    forVerifiedOrganization: () => ({ ping: mockPing, getClientes: mockGetClientes }),
  },
  extractBlingImageUrl: () => null,
}));
vi.mock('@/lib/crypto', () => ({
  checkEncryptionConfiguration: () => ({ _tag: 'ValidEncryptionConfiguration' }),
}));
vi.mock('@/repositories/syncJobRepository', () => ({
  enqueueJob: (...args: unknown[]) => mockEnqueueJob(...args),
  acquireLease: (...args: unknown[]) => mockAcquireLease(...args),
  advanceCheckpoint: vi.fn(),
  completeJob: (...args: unknown[]) => mockCompleteJob(...args),
  getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  releaseExpiredLeases: vi.fn().mockResolvedValue(0),
}));

function requisicao(autorizada = true): Request {
  return new Request('https://orbita.test/api/startup', {
    method: 'POST',
    headers: autorizada ? { Authorization: 'Bearer token-de-sessao' } : {},
  });
}

function vinculoDe(papel: 'owner' | 'admin' | 'member' | null) {
  mockContextoAtivo.mockResolvedValue({ data: null, error: null });
  mockVinculo.mockResolvedValue({
    data: papel === null ? null : {
      papel,
      organizacao_id: ORG_ID,
      organizacoes: {
        id: ORG_ID,
        nome: 'Organização de teste',
        slug: 'org-teste',
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-01T00:00:00Z',
      },
    },
    error: null,
  });
}

describe('POST /api/startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetUser.mockResolvedValue({
      data: { user: { id: OWNER_ID, app_metadata: { provider: 'email', providers: ['email'] } } },
      error: null,
    });
    vinculoDe('owner');
    mockPing.mockResolvedValue(true);
    mockEnqueueJob.mockResolvedValue({ jobId: 'job-1', status: 'queued', isNew: true });
    mockAcquireLease.mockResolvedValue(true);
    mockCompleteJob.mockResolvedValue(undefined);
    mockGetClientes.mockResolvedValue([]);
  });

  it('devolve 401 sem sessão', async () => {
    const { POST } = await import('./route');
    expect((await POST(requisicao(false))).status).toBe(401);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('devolve 403 ao membro, porque sincronizar é ação de gestão', async () => {
    vinculoDe('member');
    const { POST } = await import('./route');
    expect((await POST(requisicao())).status).toBe(403);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('não anuncia sucesso quando a sincronização falhou', async () => {
    mockGetClientes.mockRejectedValue(new Error('Bling fora do ar'));
    mockGetJobStatus.mockResolvedValue({
      status: 'failed',
      progress: { clientes_processados: 0, produtos_processados: 0, pedidos_processados: 0 },
    });
    const { POST } = await import('./route');

    const resposta = await POST(requisicao());
    const corpo = await resposta.json();

    expect(resposta.status).toBe(500);
    expect(corpo.success).toBe(false);
    expect(corpo.error).toBe('Erro interno durante sincronização inicial');
    // A mensagem pública não varia com a causa, e não carrega diagnóstico.
    expect(JSON.stringify(corpo)).not.toContain('Bling fora do ar');
  });

  // `running` é o único estado que prova que alguém pegou o trabalho.
  it('trata "já estava rodando" como sucesso, e não como falha', async () => {
    mockAcquireLease.mockResolvedValue(false);
    mockGetJobStatus.mockResolvedValue({
      status: 'running',
      progress: { clientes_processados: 7, produtos_processados: 0, pedidos_processados: 0 },
    });
    const { POST } = await import('./route');

    const resposta = await POST(requisicao());
    const corpo = await resposta.json();

    expect(resposta.status).toBe(200);
    expect(corpo).toMatchObject({ success: true, stats: null });
  });

  // O bloqueante que a correção da lease criou: `acquireLease` rejeita, o job
  // não é encerrado (correto — pode pertencer a outro worker), fica `queued`, e
  // a rota lia `queued` como "já está rodando". `queued` não prova que alguém
  // pegou o trabalho; pode ser que ninguém tenha conseguido nem tentar.
  it('não anuncia sucesso quando a preparação falhou e o job segue pendente', async () => {
    mockAcquireLease.mockRejectedValue(new Error('Falha ao adquirir lease: timeout'));
    mockGetJobStatus.mockResolvedValue({
      status: 'queued',
      progress: { clientes_processados: 0, produtos_processados: 0, pedidos_processados: 0 },
    });
    const { POST } = await import('./route');

    const resposta = await POST(requisicao());
    const corpo = await resposta.json();

    expect(resposta.status).toBe(503);
    expect(corpo.success).toBe(false);
    expect(corpo.error).toContain('pendente');
    expect(JSON.stringify(corpo)).not.toContain('já está rodando');
    // O job não foi encerrado: pode pertencer a outro worker.
    expect(mockCompleteJob).not.toHaveBeenCalled();
  });

  // Mesmo sem falha de preparação, `queued` continua não sendo prova de nada.
  it('não anuncia sucesso quando o job ficou apenas enfileirado', async () => {
    mockAcquireLease.mockResolvedValue(false);
    mockGetJobStatus.mockResolvedValue({
      status: 'queued',
      progress: { clientes_processados: 0, produtos_processados: 0, pedidos_processados: 0 },
    });
    const { POST } = await import('./route');

    const resposta = await POST(requisicao());
    expect(resposta.status).toBe(503);
    expect((await resposta.json()).success).toBe(false);
  });

  it('anuncia sucesso apenas quando o job concluiu', async () => {
    mockGetJobStatus.mockResolvedValue({
      status: 'completed',
      progress: { clientes_processados: 4, produtos_processados: 2, pedidos_processados: 1 },
    });
    const { POST } = await import('./route');

    const resposta = await POST(requisicao());
    const corpo = await resposta.json();

    expect(resposta.status).toBe(200);
    expect(corpo).toMatchObject({
      success: true,
      stats: { clientes: 4, produtos: 2, pedidos: 1 },
    });
  });
});
