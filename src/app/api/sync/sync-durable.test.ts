/**
 * sync-durable.test.ts
 * Ticket 34: Testes de integração dos endpoints de sync durável.
 * Cobre: POST retorna 202 + jobId, GET /status retorna estado correto,
 * idempotência (job existente), 401/403/400/404.
 *
 * Ticket 22 — a sessão deixou de ser fabricada. Antes o teste substituía
 * `verifySessionAndRole` por um retorno pronto com `role: 'dono'`, papel que o
 * provedor de identidade nunca emite para contas criadas pelos fluxos atuais;
 * assim ele ficava verde sobre uma autorização que ninguém exercitava. Agora o
 * provedor de identidade e `membros_organizacao` são dublês fiéis à forma real.
 *
 * As negações que o serviço sinalizava por exceção (`SyncScopeDeniedError` e
 * `SyncAuthorizationStoreUnavailableError`) passaram a nascer na fronteira, que
 * é onde a autorização acontece — então os testes que as injetavam foram
 * reescritos para negar pela mesma via que a produção nega.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

// ---------------------------------------------------------------------------
// Hoisted mocks e IDs
// ---------------------------------------------------------------------------

const {
  JOB_ID_NOVO,
  JOB_ID_EXISTENTE,
  ORG_ID,
  USER_ID,
  mockGetUser,
  mockContextoAtivo,
  mockVinculo,
  mockEnqueueSync,
  mockProcessJob,
  mockGetJobStatus,
  mockAfter,
} = vi.hoisted(() => {
  // UUIDs válidos de verdade (versão 4, variante 8). Os anteriores tinham a
  // forma certa e a versão errada, e nunca foram validados porque a sessão era
  // fabricada — a autorização real os recusa, e recusaria em produção também.
  const JOB_ID_NOVO = 'aaaaaaaa-0000-4000-8000-000000000001';
  const JOB_ID_EXISTENTE = 'bbbbbbbb-0000-4000-8000-000000000002';
  const ORG_ID = 'cccccccc-0000-4000-8000-000000000003';
  const USER_ID = 'dddddddd-0000-4000-8000-000000000004';

  return {
    JOB_ID_NOVO,
    JOB_ID_EXISTENTE,
    ORG_ID,
    USER_ID,
    mockGetUser: vi.fn(),
    mockContextoAtivo: vi.fn(),
    mockVinculo: vi.fn(),
    mockEnqueueSync: vi.fn(),
    mockProcessJob: vi.fn(),
    mockGetJobStatus: vi.fn(),
    mockAfter: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Dublê do PostgREST no formato que `SupabaseOrganizationMemberships` usa. */
vi.mock('../../../lib/supabaseServer', () => ({
  supabaseServer: {
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
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

vi.mock('../../../services/sync', () => ({
  syncService: {
    enqueueSync: (...args: unknown[]) => mockEnqueueSync(...args),
    processJob: (...args: unknown[]) => mockProcessJob(...args),
    getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  },
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (...args: unknown[]) => mockAfter(...args),
  };
});

// ---------------------------------------------------------------------------
// Importações após mocks
// ---------------------------------------------------------------------------

import { POST as syncPost } from './route';
import { GET as syncStatusGet } from './status/route';

/** Sessao real: o `app_metadata` que o Supabase emite nao carrega papel. */
function comSessao(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: USER_ID, app_metadata: { provider: 'email', providers: ['email'] } } },
    error: null,
  });
}

/**
 * Requisicao com credencial. Antes o teste nao mandava `Authorization` nenhum e
 * passava assim mesmo, porque a sessao era fabricada; agora o bearer e a unica
 * porta de entrada, como em producao.
 */
function requisicao(url: string, init: { method?: string } = {}): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    headers: { Authorization: 'Bearer token-de-sessao' },
  });
}

function semSessao(): void {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid', status: 401 } });
}

/** Vinculo persistido -- a autoridade sobre papel. */
function comVinculo(papel: 'owner' | 'admin' | 'member' | null): void {
  mockContextoAtivo.mockResolvedValue({ data: null, error: null });
  mockVinculo.mockResolvedValue({
    data: papel === null ? null : {
      papel,
      organizacao_id: ORG_ID,
      organizacoes: {
        id: ORG_ID,
        nome: 'Organizacao de teste',
        slug: 'org-teste',
        created_at: '2026-08-20T18:00:00Z',
        updated_at: '2026-08-20T18:00:00Z',
      },
    },
    error: null,
  });
}

function comFalhaNoDepositoDeVinculos(mensagem: string, codigo: string): void {
  mockContextoAtivo.mockResolvedValue({ data: null, error: null });
  mockVinculo.mockResolvedValue({ data: null, error: { message: mensagem, code: codigo } });
}

beforeEach(() => {
  vi.clearAllMocks();
  comSessao();
  comVinculo('owner');
  mockEnqueueSync.mockResolvedValue({
    jobId: JOB_ID_NOVO,
    status: 'queued',
    isNew: true,
  });
  mockProcessJob.mockResolvedValue(undefined);
  mockGetJobStatus.mockResolvedValue({
    id: JOB_ID_NOVO,
    organizacao_id: ORG_ID,
    status: 'running',
    progress: { etapa_atual: 'clientes', clientes_processados: 42 },
    last_error: null,
    created_at: '2026-08-20T18:00:00Z',
    updated_at: '2026-08-20T18:01:00Z',
    completed_at: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/sync
// ---------------------------------------------------------------------------

describe('POST /api/sync — Jobs duráveis', () => {
  it('retorna 202 com jobId e status queued para novo job', async () => {
    mockEnqueueSync.mockResolvedValueOnce({
      jobId: JOB_ID_NOVO,
      status: 'queued',
      isNew: true,
    });

    const req = requisicao('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.jobId).toBe(JOB_ID_NOVO);
    expect(body.status).toBe('queued');
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it('retorna 202 com job existente quando já há job ativo (idempotência)', async () => {
    mockEnqueueSync.mockResolvedValueOnce({
      jobId: JOB_ID_EXISTENTE,
      status: 'running',
      isNew: false,
    });

    const req = requisicao('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBe(JOB_ID_EXISTENTE);
    expect(body.status).toBe('running');
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('retorna 401 para requisição não autenticada', async () => {
    semSessao();

    const req = requisicao('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);
    expect(res.status).toBe(401);
    expect(mockEnqueueSync).not.toHaveBeenCalled();
  });

  it('retorna 403 para membro sem capacidade de gestão', async () => {
    comVinculo('member');

    const req = requisicao('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);
    expect(res.status).toBe(403);
    expect(mockEnqueueSync).not.toHaveBeenCalled();
  });

  it('retorna 403 quando o vínculo persistido foi revogado', async () => {
    comVinculo(null);
    const res = await syncPost(requisicao('http://localhost/api/sync', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(mockEnqueueSync).not.toHaveBeenCalled();
  });

  // Ticket 22 — política fixada em teste: a autorização acontece antes do 202,
  // e o `after()` recebe o escopo já verificado. Um job validamente enfileirado
  // continua mesmo que o vínculo do ator seja revogado depois — o job é da
  // organização, não da pessoa. O que a revogação impede é enfileirar de novo.
  it('agenda o processamento com o escopo verificado antes da resposta, e não reautoriza', async () => {
    const req = requisicao('http://localhost/api/sync', { method: 'POST' });
    const res = await syncPost(req);
    expect(res.status).toBe(202);

    expect(mockAfter).toHaveBeenCalledTimes(1);
    const callback = mockAfter.mock.calls[0]![0] as () => Promise<void>;

    // A revogação chega depois do 202: a partir daqui, ninguém tem vínculo.
    comVinculo(null);
    await callback();

    // O job segue com o escopo que foi verificado antes, e a organização dele é
    // a mesma — a callback não consulta o vínculo de novo.
    expect(mockProcessJob).toHaveBeenCalledTimes(1);
    expect(mockProcessJob.mock.calls[0]![1]).toMatchObject({ organizationId: ORG_ID });
  });

  it('nega o enfileiramento seguinte, depois que o vínculo é revogado', async () => {
    comVinculo(null);
    const res = await syncPost(requisicao('http://localhost/api/sync', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(mockEnqueueSync).not.toHaveBeenCalled();
  });

  it('retorna 503 sem expor diagnóstico quando o authorization store está indisponível', async () => {
    comFalhaNoDepositoDeVinculos('postgres detail', '08006');
    const res = await syncPost(requisicao('http://localhost/api/sync', { method: 'POST' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('Serviço de autorização indisponível');
    expect(JSON.stringify(body)).not.toContain('postgres detail');
  });

  it('mascara erros internos desconhecidos', async () => {
    mockEnqueueSync.mockRejectedValueOnce(new Error('password authentication failed for postgres'));
    const res = await syncPost(requisicao('http://localhost/api/sync', { method: 'POST' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Erro interno na sincronização');
    expect(JSON.stringify(body)).not.toContain('postgres');
  });
});

// ---------------------------------------------------------------------------
// GET /api/sync/status
// ---------------------------------------------------------------------------

describe('GET /api/sync/status — Estado observável', () => {
  it('retorna o estado do job quando job_id é válido', async () => {
    const jobData = {
      id: JOB_ID_NOVO,
      organizacao_id: ORG_ID,
      status: 'running',
      progress: { etapa_atual: 'produtos', produtos_processados: 80 },
      last_error: null,
      created_at: '2026-08-20T18:00:00Z',
      updated_at: '2026-08-20T18:02:00Z',
      completed_at: null,
    };
    mockGetJobStatus.mockResolvedValueOnce(jobData);

    const req = requisicao(`http://localhost/api/sync/status?job_id=${JOB_ID_NOVO}`);
    const res = await syncStatusGet(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.job.status).toBe('running');
    expect(body.job.progress.etapa_atual).toBe('produtos');
  });

  it('retorna 404 quando job não existe ou não pertence à organização', async () => {
    mockGetJobStatus.mockResolvedValueOnce(null);

    const req = requisicao(`http://localhost/api/sync/status?job_id=nao-existe`);
    const res = await syncStatusGet(req);
    expect(res.status).toBe(404);
  });

  it('retorna 400 quando job_id não é fornecido', async () => {
    const req = requisicao('http://localhost/api/sync/status');
    const res = await syncStatusGet(req);
    expect(res.status).toBe(400);
  });

  it('retorna 401 para requisição não autenticada', async () => {
    semSessao();

    const req = requisicao(`http://localhost/api/sync/status?job_id=${JOB_ID_NOVO}`);
    const res = await syncStatusGet(req);
    expect(res.status).toBe(401);
    expect(mockGetJobStatus).not.toHaveBeenCalled();
  });

  // Ler o andamento é leitura: o membro pode, e é por isso que a capacidade de
  // gestão não é exigida aqui, ao contrário do POST que dispara a sincronização.
  it('responde ao membro, que não precisa de gestão para acompanhar o job', async () => {
    comVinculo('member');
    mockGetJobStatus.mockResolvedValueOnce({
      id: JOB_ID_NOVO,
      organizacao_id: ORG_ID,
      status: 'running',
      progress: { etapa_atual: 'clientes' },
      last_error: null,
      created_at: '2026-08-20T18:00:00Z',
      updated_at: '2026-08-20T18:01:00Z',
      completed_at: null,
    });

    const req = requisicao(`http://localhost/api/sync/status?job_id=${JOB_ID_NOVO}`);
    expect((await syncStatusGet(req)).status).toBe(200);
  });

  it('retorna estado completed quando job foi concluído com sucesso', async () => {
    const jobData = {
      id: JOB_ID_NOVO,
      organizacao_id: ORG_ID,
      status: 'completed',
      progress: {
        etapa_atual: 'concluido',
        clientes_processados: 100,
        produtos_processados: 200,
        pedidos_processados: 50,
      },
      last_error: null,
      created_at: '2026-08-20T18:00:00Z',
      updated_at: '2026-08-20T18:05:00Z',
      completed_at: '2026-08-20T18:05:00Z',
    };
    mockGetJobStatus.mockResolvedValueOnce(jobData);

    const req = requisicao(`http://localhost/api/sync/status?job_id=${JOB_ID_NOVO}`);
    const res = await syncStatusGet(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.status).toBe('completed');
    expect(body.job.completed_at).toBeTruthy();
  });

  it('retorna 503 sanitizado quando o authorization store falha', async () => {
    comFalhaNoDepositoDeVinculos('relation missing', '42P01');
    const req = requisicao(`http://localhost/api/sync/status?job_id=${JOB_ID_NOVO}`);
    const res = await syncStatusGet(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('Serviço de autorização indisponível');
    expect(JSON.stringify(body)).not.toContain('relation missing');
  });
});
